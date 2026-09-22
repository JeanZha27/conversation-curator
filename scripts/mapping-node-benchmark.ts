import { execFile } from "node:child_process";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MAX_MAPPING_NODES } from "../src/adapters/chatgpt.ts";

const execFileAsync = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "curator-mapping-node-benchmark-"));
const inputPath = join(directory, "conversations.json");
const outputPath = join(directory, "report.json");

try {
  const input = await open(inputPath, "wx", 0o600);
  try {
    await input.writeFile('[{"id":"synthetic-many-nodes","mapping":{', "utf8");
    for (let index = 0; index <= MAX_MAPPING_NODES; index += 1) {
      const prefix = index === 0 ? "" : ",";
      await input.writeFile(`${prefix}"node-${index}":{"parent":null}`, "utf8");
    }
    await input.writeFile("}}]\n", "utf8");
  } finally {
    await input.close();
  }

  const startedAt = performance.now();
  const worker = await execFileAsync(
    process.execPath,
    [
      "--max-old-space-size=96",
      "--max-semi-space-size=2",
      fileURLToPath(new URL("memory-worker.ts", import.meta.url)),
      inputPath,
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const durationMs = performance.now() - startedAt;
  const measurement = JSON.parse(worker.stdout) as {
    peakRssBytes: number;
    peakHeapUsedBytes: number;
    failureCodes: string[];
    summary: { classified: number; failed: number };
  };
  const peakRssMiB = measurement.peakRssBytes / 1024 / 1024;
  const result = {
    mappingNodes: MAX_MAPPING_NODES + 1,
    inputBytes: (await stat(inputPath)).size,
    durationMs: Math.round(durationMs),
    peakRssMiB: Number(peakRssMiB.toFixed(1)),
    peakHeapUsedMiB: Number((measurement.peakHeapUsedBytes / 1024 / 1024).toFixed(1)),
    classified: measurement.summary.classified,
    failed: measurement.summary.failed,
    failureCodes: measurement.failureCodes,
    passed:
      peakRssMiB <= 256 &&
      measurement.summary.classified === 0 &&
      measurement.summary.failed === 1 &&
      measurement.failureCodes.join(",") === "MAPPING_NODE_LIMIT_EXCEEDED",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
