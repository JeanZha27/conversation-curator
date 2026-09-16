import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { CuratorError } from "./errors.ts";
import { assertOutputValueSafe } from "./output-sanitizer.ts";
import type { ReportEvent } from "../types.ts";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

export type JsonEventSink = {
  write(event: ReportEvent): Promise<void>;
  commit(): Promise<string>;
  abort(): Promise<void>;
};

export async function createJsonEventSink(options: {
  outputPath: string;
  sourcePath: string;
  force: boolean;
}): Promise<JsonEventSink> {
  const target = resolve(options.outputPath);
  if (extname(target).toLowerCase() !== ".json") {
    throw new CuratorError("INVALID_OUTPUT_TYPE", "输出文件必须使用 .json 扩展名。");
  }
  const parent = dirname(target);
  try {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) throw new Error("not directory");
  } catch {
    throw new CuratorError("OUTPUT_DIRECTORY_INVALID", "输出目录不存在或不可用。");
  }

  let sourceRealPath: string;
  try {
    sourceRealPath = await realpath(resolve(options.sourcePath));
  } catch {
    throw new CuratorError("INPUT_NOT_READABLE", "输入文件不存在或不可读取。");
  }
  if (target === sourceRealPath) {
    throw new CuratorError("OUTPUT_OVERWRITES_SOURCE", "输出路径不能覆盖输入文件。");
  }
  const exists = await pathExists(target);
  if (exists) {
    const targetRealPath = await realpath(target);
    if (targetRealPath === sourceRealPath) {
      throw new CuratorError("OUTPUT_OVERWRITES_SOURCE", "输出路径不能覆盖输入文件。");
    }
    if (!options.force) {
      throw new CuratorError("OUTPUT_EXISTS", "输出文件已存在；确认替换时请使用 --force。");
    }
  }

  const temporary = resolve(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let first = true;
  let closed = false;
  let committed = false;
  await handle.writeFile("[\n", "utf8");

  async function closeHandle(): Promise<void> {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  }

  return {
    async write(event) {
      if (closed || committed) throw new CuratorError("OUTPUT_SINK_CLOSED", "报告输出已关闭。");
      assertOutputValueSafe(event);
      const prefix = first ? "  " : ",\n  ";
      first = false;
      await handle.writeFile(`${prefix}${JSON.stringify(event)}`, "utf8");
    },
    async commit() {
      if (committed) return target;
      if (closed) throw new CuratorError("OUTPUT_SINK_CLOSED", "报告输出已关闭。");
      await handle.writeFile("\n]\n", "utf8");
      await handle.sync();
      await closeHandle();
      await rename(temporary, target);
      committed = true;
      return target;
    },
    async abort() {
      if (committed) return;
      await closeHandle().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    },
  };
}
