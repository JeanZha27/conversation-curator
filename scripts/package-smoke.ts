import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  await writeFile(
    inputPath,
    JSON.stringify([
      {
        id: "package-smoke-1",
        title: "开发 TypeScript 测试",
        current_node: "message",
        mapping: {
          message: {
            parent: null,
            message: { create_time: 1, content: { parts: ["测试已完成"] } },
          },
        },
      },
    ]),
  );

  const executable = join(consumer, "node_modules", ".bin", "conversation-curator");
  await execFileAsync(
    executable,
    ["--input", inputPath, "--write", "--output", outputPath],
    {
      cwd: consumer,
      env: executionEnvironment,
    },
  );
  const events = JSON.parse(await readFile(outputPath, "utf8")) as ReportEvent[];
  const summary = events.find((event) => event.type === "summary");
  if (summary?.type !== "summary" || summary.summary.classified !== 1) {
    throw new Error("installed package did not complete the import-scan-export loop");
  }
  process.stdout.write("package smoke test: passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
