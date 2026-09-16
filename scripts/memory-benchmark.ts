import { execFile } from "node:child_process";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const itemCount = integerArgument("--items", 50_000);
const maxRssMiB = integerArgument("--max-rss-mib", 256);
const directory = await mkdtemp(join(tmpdir(), "curator-memory-benchmark-"));
const inputPath = join(directory, "conversations.json");
const outputPath = join(directory, "report.json");

try {
  const input = await open(inputPath, "wx", 0o600);
  try {
    await input.writeFile("[\n", "utf8");
    for (let index = 0; index < itemCount; index += 1) {
      const conversation = {
        id: `synthetic-${index}`,
        title: `开发 TypeScript 测试 ${index}`,
        current_node: "answer",
        mapping: {
          question: {
            parent: null,
            message: { create_time: 1, content: { parts: [`编写本地测试 ${index}`] } },
          },
          answer: {
            parent: "question",
            message: { create_time: 2, content: { parts: ["测试已完成"] } },
          },
        },
      };
      await input.writeFile(`${index === 0 ? "" : ",\n"}${JSON.stringify(conversation)}`, "utf8");
    }
    await input.writeFile("\n]\n", "utf8");
  } finally {
    await input.close();
  }

  const startedAt = performance.now();
  const worker = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("memory-worker.ts", import.meta.url)), inputPath, outputPath],
    { maxBuffer: 1024 * 1024 },
  );
  const durationMs = performance.now() - startedAt;
  const measurement = JSON.parse(worker.stdout) as {
    peakRssBytes: number;
    summary: { classified: number };
  };
  const inputBytes = (await stat(inputPath)).size;
  const outputBytes = (await stat(outputPath)).size;
  const peakRssMiB = measurement.peakRssBytes / 1024 / 1024;
  const result = {
    itemCount,
    inputBytes,
    outputBytes,
    durationMs: Math.round(durationMs),
    peakRssMiB: Number(peakRssMiB.toFixed(1)),
    limitMiB: maxRssMiB,
    classified: measurement.summary.classified,
    passed: peakRssMiB <= maxRssMiB && measurement.summary.classified === itemCount,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
