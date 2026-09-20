import { execFile } from "node:child_process";
import { basename } from "node:path";
import { extname } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { approvedMarkerCount, isApprovedSyntheticMarker, markerDigest } from "./approved-synthetic-markers.ts";
import { isApprovedGitleaksConfig } from "./approved-gitleaks-config.ts";
import { isApprovedGitleaksIgnore } from "./approved-gitleaks-ignore.ts";
import { scanSensitiveText } from "../src/core/security-scanner.ts";

const execFileAsync = promisify(execFile);

const forbiddenBasenames = new Set([
  ".DS_Store",
  ".env",
  "conversation-report.json",
  "conversations.json",
  "report.json",
]);

function forbiddenPath(path: string): boolean {
  const name = basename(path);
  return (
    path.startsWith(".private-test-data/") ||
    path.startsWith(".private-reports/") ||
    path.startsWith("dist/") ||
    path.startsWith("node_modules/") ||
    forbiddenBasenames.has(name) ||
    /^\.env\./u.test(name) ||
    /(?:\.log|\.report\.json|\.tgz|\.tmp)$/u.test(name)
  );
}

function resemblesPrivateArtifact(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const records = value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
  if (records.length !== value.length) return false;
  const looksLikeExport = records.some(
    (entry) =>
      typeof entry.id === "string" &&
      typeof entry.mapping === "object" &&
      entry.mapping !== null,
  );
  const eventTypes = new Set(records.map((entry) => entry.type));
  const looksLikeReport = eventTypes.has("header") && eventTypes.has("summary");
  return looksLikeExport || looksLikeReport;
}

const { stdout } = await execFileAsync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024,
  },
);
const tracked = stdout.toString("utf8").split("\0").filter(Boolean);
let violations = 0;
const scannedTextExtensions = new Set([".ts", ".js", ".json", ".yml", ".yaml", ".md", ".toml"]);
const regularTracked: string[] = [];
const inlineMarker = ["gitleaks", "allow"].join(":");
const seenApprovedMarkers = new Set<string>();

for (const path of tracked) {
  try {
    if ((await lstat(path)).isFile()) regularTracked.push(path);
    else violations += 1;
  } catch {
    violations += 1;
  }
}

for (const path of regularTracked) {
  if (forbiddenPath(path)) {
    violations += 1;
    continue;
  }
  if (!path.endsWith(".json")) continue;
  try {
    if (resemblesPrivateArtifact(JSON.parse(await readFile(path, "utf8")))) violations += 1;
  } catch {
    // Syntax validation belongs to the file's owning tool. This policy only
    // recognizes valid JSON artifacts without echoing their contents.
  }
}

for (const path of regularTracked) {
  // An inline suppression can hide a Gitleaks finding in any tracked file,
  // regardless of its extension. Validate it before applying text scan scope.
  const content = await readFile(path);
  if (!content.includes(inlineMarker) &&
    (path === "pnpm-lock.yaml" || !scannedTextExtensions.has(extname(path)))) continue;
  const scanText = path !== "pnpm-lock.yaml" && scannedTextExtensions.has(extname(path));
  const lines = content.toString("utf8").split(/\r?\n/u);
  for (const line of lines) {
    if (line.includes(inlineMarker)) {
      if (isApprovedSyntheticMarker(path, line)) {
        seenApprovedMarkers.add(markerDigest(path, line));
      } else {
        violations += 1;
      }
      continue;
    }
    if (!scanText) continue;
    const scan = scanSensitiveText(line);
    if (scan.hardMatch || scan.candidateMatch) violations += 1;
  }
}

if (seenApprovedMarkers.size !== approvedMarkerCount) violations += 1;

if (regularTracked.includes(".gitleaks.toml")) {
  const gitleaksConfig = await readFile(".gitleaks.toml", "utf8");
  const allowlistBlocks = gitleaksConfig.match(/\[\[allowlists\]\]/gu)?.length ?? 0;
  if (
    !isApprovedGitleaksConfig(gitleaksConfig) ||
    allowlistBlocks !== 1 ||
    /^\s*(?:paths|commits|rules|stopwords)\s*=/gimu.test(gitleaksConfig) ||
    !/^\s*regexTarget\s*=\s*"line"\s*$/gimu.test(gitleaksConfig)
  ) {
    violations += 1;
  }
}

if (
  !regularTracked.includes(".gitleaksignore") ||
  !isApprovedGitleaksIgnore(await readFile(".gitleaksignore", "utf8"))
) {
  violations += 1;
}

if (violations > 0) {
  process.stderr.write(`repository policy: blocked (${violations} forbidden tracked artifacts)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("repository policy: passed\n");
}
