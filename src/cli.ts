#!/usr/bin/env node

import { CuratorError, isAbortError } from "./core/errors.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonEventSink, type JsonEventSink } from "./core/json-event-sink.ts";
import { runCurator } from "./core/pipeline.ts";
import type { CuratorRunResult } from "./types.ts";

type CliOptions = {
  inputPath: string | null;
  outputPath: string | null;
  write: boolean;
  force: boolean;
  help: boolean;
};

const USAGE = `用法：
  node src/cli.ts --input <conversations.json>
  node src/cli.ts --input <conversations.json> --write --output <report.json> [--force]

选项：
  --input   ChatGPT 导出的 conversations.json
  --write   显式允许写出本地报告
  --output  JSON 报告路径；必须与 --write 同时使用
  --force   显式允许替换已存在的输出报告
  --help    显示帮助
`;

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputPath: null,
    outputPath: null,
    write: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--input") options.inputPath = argv[++index] ?? null;
    else if (argument === "--output") options.outputPath = argv[++index] ?? null;
    else throw new CuratorError("UNKNOWN_ARGUMENT", `未知参数：${argument}`);
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

function printPreview(report: CuratorRunResult): void {
  const { summary } = report;
  process.stdout.write(
    [
      "\n本地整理预览",
      `来源：${report.header.source.fileName}`,
      `总项：${summary.totalItems}`,
      `已分类：${summary.classified}`,
      `建议接受：${summary.suggestedAccept}`,
      `需人工复核：${summary.requiresReview}`,
      `重复：${summary.duplicates}`,
      `失败：${summary.failed}`,
      `S3：${summary.s3}`,
      `S3 候选：${summary.s3Candidates}`,
      "",
    ].join("\n"),
  );

  for (const item of report.previewConversations) {
    const state = item.classification.requiresReview ? "需复核" : "建议接受";
    process.stdout.write(
      `- ${item.conversationRef} | ${state} | ${item.classification.suggestedTitle} | ${item.security.sensitivityLevel}\n`,
    );
  }
  if (summary.classified > report.previewConversations.length) {
    process.stdout.write(`- 另有 ${summary.classified - report.previewConversations.length} 项未在终端展开。\n`);
  }
  for (const failure of report.previewFailures) {
    process.stdout.write(`- 失败项 ${failure.itemIndex ?? "未知"} | ${failure.code} | ${failure.message}\n`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const curatorError = error instanceof CuratorError ? error : new CuratorError("ARGUMENT_ERROR", "参数解析失败。");
    process.stderr.write(`错误 [${curatorError.code}]：${curatorError.message}\n\n${USAGE}`);
    return curatorError.exitCode;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  let sink: JsonEventSink | null = null;

  try {
    if (options.write) {
      sink = await createJsonEventSink({
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
    printPreview(report);
    if (sink) {
      const writtenPath = await sink.commit();
      process.stdout.write(`\n报告已写入：${writtenPath}\n`);
    } else {
      process.stdout.write("\n当前为只预览模式；未写入报告。使用 --write --output <path> 可显式导出。\n");
    }
    return report.summary.failed > 0 ? 2 : 0;
  } catch (error) {
    await sink?.abort();
    if (isAbortError(error)) {
      process.stderr.write("操作已取消；未留下未完成的报告。\n");
      return 130;
    }
    const curatorError =
      error instanceof CuratorError
        ? error
        : new CuratorError("UNEXPECTED_ERROR", "发生未预期错误；未写入报告。");
    process.stderr.write(`错误 [${curatorError.code}]：${curatorError.message}\n`);
    return curatorError.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

export function isMainModule(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvEntry));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "未知入口错误";
    process.stderr.write(`错误 [ENTRY_RESOLUTION_FAILED]：无法确认 CLI 入口：${detail}\n`);
    process.exitCode = 1;
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
