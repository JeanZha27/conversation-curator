import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CuratorError } from "../src/core/errors.ts";
import { runCurator } from "../src/core/pipeline.ts";
import type { ReportSummary } from "../src/types.ts";

export const PRIVATE_SAMPLE_PATH = resolve(".private-test-data", "conversations.json");

export async function checkCompatibility(inputPath: string): Promise<ReportSummary> {
  try {
    await access(inputPath);
  } catch {
    throw new CuratorError(
      "PRIVATE_SAMPLE_MISSING",
      "脱敏私有导出不存在，真实格式兼容测试保持阻塞。",
      2,
    );
  }

  const report = await runCurator({ inputPath });
  if (report.summary.totalItems === 0 || report.summary.classified === 0) {
    throw new CuratorError(
      "PRIVATE_SAMPLE_NO_CLASSIFIED_ITEMS",
      "脱敏私有导出没有产生可分类项，不能解除兼容测试阻塞。",
      2,
    );
  }
  if (report.summary.failed > 0) {
    throw new CuratorError(
      "PRIVATE_SAMPLE_PARTIAL_FAILURE",
      "脱敏私有导出存在处理失败项，不能解除兼容测试阻塞。",
      2,
    );
  }
  if (report.privacy.sensitiveValuesIncluded) {
    throw new CuratorError(
      "PRIVATE_SAMPLE_OUTPUT_UNSAFE",
      "最终输出安全断言未通过，不能解除兼容测试阻塞。",
      2,
    );
  }

  return report.summary;
}

function isMainModule(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvEntry));
  } catch {
    return false;
  }
}

export async function main(): Promise<number> {
  try {
    const summary = await checkCompatibility(PRIVATE_SAMPLE_PATH);
    process.stdout.write(
      `private compatibility check: passed (${summary.classified}/${summary.totalItems} classified)\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof CuratorError ? error.code : "PRIVATE_COMPATIBILITY_FAILED";
    process.stderr.write(`private compatibility check: blocked [${code}]\n`);
    return error instanceof CuratorError ? error.exitCode : 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
