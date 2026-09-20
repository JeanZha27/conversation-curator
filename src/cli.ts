#!/usr/bin/env node

import { CuratorError, isAbortError, outputCleanupError } from "./core/errors.ts";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonEventSink, type JsonEventSink } from "./core/json-event-sink.ts";
import { sanitizeOutputString } from "./core/output-sanitizer.ts";
import { runCurator } from "./core/pipeline.ts";
import type { CuratorRunResult } from "./types.ts";

type CliOptions = {
  inputPath: string | null;
  outputPath: string | null;
  write: boolean;
  force: boolean;
  summaryOnly: boolean;
  help: boolean;
};

export type CliRuntimeHooks = {
  beforeCommit?: (() => void | Promise<void>) | undefined;
  createSink?: typeof createJsonEventSink | undefined;
};

const USAGE = `用法：
  node src/cli.ts --input <conversations.json>
  node src/cli.ts --input <conversations.json> --write --output <report.json> [--force]

选项：
  --input   ChatGPT 导出的 conversations.json
  --write   显式允许写出本地报告
  --output  JSON 报告路径；必须与 --write 同时使用
  --force   显式允许替换已存在的输出报告
  --summary-only  只输出汇总计数，不显示逐条分类建议
  --help    显示帮助
`;
const BOUNDED_HEAP_FLAGS = ["--max-old-space-size=96", "--max-semi-space-size=2"] as const;

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputPath: null,
    outputPath: null,
    write: false,
    force: false,
    summaryOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--summary-only") options.summaryOnly = true;
    else if (argument === "--input") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CuratorError("INPUT_VALUE_REQUIRED", "--input 后必须提供输入文件路径。");
      }
      options.inputPath = value;
      index += 1;
    } else if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CuratorError("OUTPUT_VALUE_REQUIRED", "--output 后必须提供报告文件路径。");
      }
      options.outputPath = value;
      index += 1;
    }
    else throw new CuratorError("UNKNOWN_ARGUMENT", "存在未知参数；请按帮助中的选项重试。");
  }

  if (options.help) return options;
  if (!options.inputPath) throw new CuratorError("INPUT_REQUIRED", "缺少 --input 输入文件。");
  if (options.write && !options.outputPath) {
    throw new CuratorError("OUTPUT_REQUIRED", "使用 --write 时必须提供 --output。");
  }
  if (!options.write && options.outputPath) {
    throw new CuratorError("WRITE_CONFIRMATION_REQUIRED", "提供 --output 前必须显式使用 --write。");
  }
  if (options.force && !options.write) {
    throw new CuratorError("FORCE_WITHOUT_WRITE", "--force 只能与 --write 一起使用。");
  }
  return options;
}

function printPreview(report: CuratorRunResult, summaryOnly: boolean): void {
  const { summary } = report;
  writeStdout(
    [
      "\n本地整理预览",
      `来源：${report.header.source.fileName}`,
      `总项：${summary.totalItems}`,
      `已分类：${summary.classified}`,
      `建议接受：${summary.suggestedAccept}`,
      `需人工复核：${summary.requiresReview}`,
      `重复：${summary.duplicates}`,
      `失败：${summary.failed}`,
      `当前分支：${summary.currentBranchParsed}`,
      `分支降级：${summary.branchFallbacks}`,
      `内容不可用：${summary.contentUnavailable}`,
      `分类文本截断：${summary.classificationTruncated}`,
      `S3：${summary.s3}`,
      `S3 候选：${summary.s3Candidates}`,
      "",
    ].join("\n"),
  );

  if (summaryOnly) return;

  for (const item of report.previewConversations) {
    const state = item.classification.requiresReview ? "需复核" : "建议接受";
    writeStdout(
      `- ${item.conversationRef} | ${state} | ${item.classification.suggestedTitle} | ${item.security.sensitivityLevel}\n`,
    );
  }
  if (summary.classified > report.previewConversations.length) {
    writeStdout(`- 另有 ${summary.classified - report.previewConversations.length} 项未在终端展开。\n`);
  }
  for (const failure of report.previewFailures) {
    writeStdout(`- 失败项 ${failure.itemIndex ?? "未知"} | ${failure.code} | ${failure.message}\n`);
  }
}

function writeStdout(value: string): void {
  process.stdout.write(sanitizeOutputString(value).value);
}

function writeStderr(value: string): void {
  process.stderr.write(sanitizeOutputString(value).value);
}

export async function main(
  argv = process.argv.slice(2),
  runtimeHooks: CliRuntimeHooks = {},
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const curatorError = error instanceof CuratorError ? error : new CuratorError("ARGUMENT_ERROR", "参数解析失败。");
    writeStderr(`错误 [${curatorError.code}]：${curatorError.message}\n\n${USAGE}`);
    return curatorError.exitCode;
  }

  if (options.help) {
    writeStdout(USAGE);
    return 0;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  // Keep the handler installed after the first signal so a second SIGINT
  // cannot bypass stream closing and temporary-file cleanup.
  process.on("SIGINT", cancel);
  let sink: JsonEventSink | null = null;

  try {
    if (options.write) {
      sink = await (runtimeHooks.createSink ?? createJsonEventSink)({
        outputPath: options.outputPath!,
        sourcePath: options.inputPath!,
        force: options.force,
      });
    }
    const report = await runCurator({
      inputPath: options.inputPath!,
      signal: controller.signal,
      onEvent: sink?.write,
    });
    controller.signal.throwIfAborted();
    printPreview(report, options.summaryOnly);
    if (sink) {
      await runtimeHooks.beforeCommit?.();
      controller.signal.throwIfAborted();
      await sink.commit(controller.signal);
      writeStdout("\n报告已安全写入。\n");
    } else {
      writeStdout("\n当前为只预览模式；未写入报告。使用 --write --output <path> 可显式导出。\n");
    }
    return report.summary.failed > 0 || report.summary.duplicates > 0 || report.summary.classified === 0 ? 2 : 0;
  } catch (error) {
    let cleanupFailed = false;
    try {
      await sink?.abort();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      const cleanupError = outputCleanupError();
      writeStderr(`错误 [${cleanupError.code}]：${cleanupError.message}\n`);
      return cleanupError.exitCode;
    }
    if (isAbortError(error)) {
      writeStderr("操作已取消；未留下未完成的报告。\n");
      return 130;
    }
    const curatorError =
      error instanceof CuratorError
        ? error
        : new CuratorError("UNEXPECTED_ERROR", "发生未预期错误；未写入报告。");
    writeStderr(`错误 [${curatorError.code}]：${curatorError.message}\n`);
    return curatorError.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

export function isMainModule(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvEntry));
  } catch {
    writeStderr("错误 [ENTRY_RESOLUTION_FAILED]：无法确认 CLI 入口。\n");
    process.exitCode = 1;
    return false;
  }
}

async function runInBoundedHeapProcess(entryPath: string, argv: string[]): Promise<number> {
  return new Promise((resolveExitCode) => {
    const child = spawn(process.execPath, [...BOUNDED_HEAP_FLAGS, entryPath, ...argv], {
      stdio: "inherit",
    });
    const forwardInterrupt = () => child.kill("SIGINT");
    process.on("SIGINT", forwardInterrupt);
    child.once("error", () => {
      process.removeListener("SIGINT", forwardInterrupt);
      writeStderr("错误 [CLI_START_FAILED]：无法启动受控内存的 CLI 进程。\n");
      resolveExitCode(1);
    });
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", forwardInterrupt);
      resolveExitCode(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}

function installOutputStreamGuards(): void {
  const guard = (error: NodeJS.ErrnoException): void => {
    // A downstream command closing a pipe is normal CLI behavior. Avoid an
    // uncaught stack trace that could include local execution metadata.
    process.exitCode = error.code === "EPIPE" ? 0 : 1;
  };
  process.stdout.on("error", guard);
  process.stderr.on("error", guard);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  if (BOUNDED_HEAP_FLAGS.every((flag) => process.execArgv.includes(flag))) {
    installOutputStreamGuards();
    process.exitCode = await main();
  } else {
    process.exitCode = await runInBoundedHeapProcess(
      fileURLToPath(import.meta.url),
      process.argv.slice(2),
    );
  }
}
