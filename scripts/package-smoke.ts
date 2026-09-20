import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ReportEvent } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const pnpmCommand = process.env.CURATOR_PNPM_BIN ?? "pnpm";
const executionEnvironment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};
const directory = await mkdtemp(join(tmpdir(), "curator-package-smoke-"));
const consumer = join(directory, "consumer");
const inputPath = join(directory, "conversations.json");
const outputPath = join(directory, "report.json");

async function expectInstalledFailure(executable: string, args: string[], expectedCode: string): Promise<void> {
  try {
    await execFileAsync(executable, args, { cwd: consumer, env: executionEnvironment });
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 1 && failure.stderr?.includes(`错误 [${expectedCode}]`)) return;
  }
  throw new Error(`installed package did not reject ${expectedCode} safely`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function packageFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await packageFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

try {
  await execFileAsync(
    pnpmCommand,
    ["pack", "--pack-destination", directory],
    { env: executionEnvironment },
  );
  const tarball = join(directory, "conversation-curator-0.1.0.tgz");
  await access(tarball);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(consumer));
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "curator-smoke-consumer", private: true }, null, 2)}\n`,
  );
  await execFileAsync(
    pnpmCommand,
    ["add", tarball, "--offline", "--ignore-scripts"],
    { cwd: consumer, env: { ...executionEnvironment, CI: "true" } },
  );

  const sourceId = "SYNTHETIC-PRIVATE-ID";
  const sourceTitle = "SYNTHETIC-PRIVATE-TITLE";
  const sourceBody = "SYNTHETIC-PRIVATE-BODY";
  const token = `sk-${"PackageSmoke9_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
  await writeFile(
    inputPath,
    JSON.stringify([
      {
        id: sourceId,
        title: sourceTitle,
        current_node: "message",
        mapping: {
          message: {
            parent: null,
            message: { create_time: 1, content: { parts: [`${sourceBody} ${token}`] } },
          },
        },
      },
    ]),
  );
  const sourceBefore = await readFile(inputPath);

  const executable = join(consumer, "node_modules", ".bin", "conversation-curator");
  const { stdout } = await execFileAsync(
    executable,
    ["--input", inputPath, "--summary-only", "--write", "--output", outputPath],
    {
      cwd: consumer,
      env: executionEnvironment,
    },
  );
  if (stdout.includes("conv:") || stdout.includes(sourceTitle)) {
    throw new Error("installed package printed individual conversation details in summary mode");
  }
  const events = JSON.parse(await readFile(outputPath, "utf8")) as ReportEvent[];
  const serialized = JSON.stringify(events);
  const eventTypes = events.map((event) => event.type);
  const summary = events.find((event) => event.type === "summary");
  const conversation = events.find((event) => event.type === "conversation");
  const header = events.find((event) => event.type === "header");
  if (
    header?.type !== "header" ||
    header.schemaVersion !== "1.3" ||
    summary?.type !== "summary" ||
    conversation?.type !== "conversation" ||
    summary.summary.classified !== 1 ||
    summary.summary.failed !== 0 ||
    summary.summary.currentBranchParsed !== 1 ||
    summary.summary.classificationTruncated !== 0 ||
    summary.privacy.rawMessageBodiesIncluded ||
    summary.privacy.originalTitlesIncluded ||
    summary.privacy.sensitiveValuesIncluded ||
    conversation.data.conversationRef === sourceId ||
    conversation.data.classificationTruncated ||
    eventTypes.join(",") !== "header,conversation,summary" ||
    [sourceId, sourceTitle, sourceBody, token].some((value) => serialized.includes(value)) ||
    sha256(await readFile(inputPath)) !== sha256(sourceBefore)
  ) {
    throw new Error("installed package did not complete the import-scan-export loop");
  }
  const reportBefore = sha256(await readFile(outputPath));
  await expectInstalledFailure(
    executable,
    ["--input", inputPath, "--summary-only", "--write", "--output", outputPath],
    "OUTPUT_EXISTS",
  );
  if (sha256(await readFile(outputPath)) !== reportBefore) {
    throw new Error("repeat execution changed the existing report");
  }

  const invalidInput = join(directory, "invalid.json");
  const invalidOutput = join(directory, "invalid-report.json");
  await writeFile(invalidInput, "{}");
  await expectInstalledFailure(
    executable,
    ["--input", invalidInput, "--summary-only", "--write", "--output", invalidOutput],
    "INVALID_JSON_ARRAY",
  );
  await expectInstalledFailure(
    executable,
    ["--input", inputPath, "--summary-only", "--write", "--output", join(directory, "missing", "report.json")],
    "OUTPUT_DIRECTORY_INVALID",
  );
  if (
    (await readdir(directory)).some((file) => file.endsWith(".tmp") || file === "invalid-report.json" || file === "missing")
  ) {
    throw new Error("installed package left an incomplete report after failure");
  }
  const installedRoot = join(consumer, "node_modules", "conversation-curator");
  for (const required of ["README.md", "SKILL.md", "CHANGELOG.md", "LICENSE", "PRIVACY.md", "SECURITY.md"]) {
    await access(join(installedRoot, required));
  }
  const forbiddenPackageMarkers = ["/Users/", ".chatgpt-projects/"];
  for (const file of await packageFiles(installedRoot)) {
    const content = await readFile(file, "utf8");
    if (
      forbiddenPackageMarkers.some((marker) => content.includes(marker)) ||
      /\bg-p-[a-f0-9]{16,}\b/u.test(content)
    ) {
      throw new Error("installed package contains a forbidden private-environment marker");
    }
  }
  process.stdout.write("package smoke test: passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
