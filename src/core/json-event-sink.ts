import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, lstat, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { CuratorError, outputCleanupError } from "./errors.ts";
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
  commit(signal?: AbortSignal): Promise<void>;
  abort(): Promise<void>;
};

export type JsonEventSinkRuntime = {
  removeTemporary?: ((path: string) => Promise<void>) | undefined;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("操作已取消。");
  error.name = "AbortError";
  throw error;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as Error & { code?: string }).code
    : undefined;
}

export async function createJsonEventSink(options: {
  outputPath: string;
  sourcePath: string;
  force: boolean;
}, runtime: JsonEventSinkRuntime = {}): Promise<JsonEventSink> {
  const removeTemporary = runtime.removeTemporary ?? (async (path: string) => {
    await rm(path, { force: true });
  });
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
  let sourceStat;
  try {
    sourceRealPath = await realpath(resolve(options.sourcePath));
    sourceStat = await stat(sourceRealPath);
  } catch {
    throw new CuratorError("INPUT_NOT_READABLE", "输入文件不存在或不可读取。");
  }
  if (target === sourceRealPath) {
    throw new CuratorError("OUTPUT_OVERWRITES_SOURCE", "输出路径不能覆盖输入文件。");
  }
  const exists = await pathExists(target);
  if (exists) {
    let targetIsSource = false;
    try {
      const targetStat = await stat(target);
      targetIsSource = targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino;
    } catch {
      // A broken symlink still occupies the output name. Without --force it
      // remains an existing target; with --force the atomic rename replaces
      // the link itself rather than following it.
    }
    if (targetIsSource) {
      throw new CuratorError("OUTPUT_OVERWRITES_SOURCE", "输出路径不能覆盖输入文件。");
    }
    if (!options.force) {
      throw new CuratorError("OUTPUT_EXISTS", "输出文件已存在；确认替换时请使用 --force。");
    }
  }

  const temporary = resolve(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile("[\n", "utf8");
  } catch (error) {
    let cleanupFailed = false;
    await handle?.close().catch(() => { cleanupFailed = true; });
    await removeTemporary(temporary).catch(() => { cleanupFailed = true; });
    if (cleanupFailed) throw outputCleanupError();
    throw error;
  }
  let first = true;
  let closed = false;
  let committed = false;

  async function closeHandle(): Promise<void> {
    if (!closed) {
      closed = true;
      await handle!.close();
    }
  }

  return {
    async write(event) {
      if (closed || committed) throw new CuratorError("OUTPUT_SINK_CLOSED", "报告输出已关闭。");
      assertOutputValueSafe(event);
      const prefix = first ? "  " : ",\n  ";
      first = false;
      await handle!.writeFile(`${prefix}${JSON.stringify(event)}`, "utf8");
    },
    async commit(signal) {
      if (committed) return;
      if (closed) throw new CuratorError("OUTPUT_SINK_CLOSED", "报告输出已关闭。");
      throwIfAborted(signal);
      await handle!.writeFile("\n]\n", "utf8");
      throwIfAborted(signal);
      await handle!.sync();
      throwIfAborted(signal);
      await closeHandle();
      throwIfAborted(signal);
      if (options.force) {
        await rename(temporary, target);
        committed = true;
        return;
      }
      try {
        // A hard link publishes the already-synced file atomically while
        // preserving no-overwrite semantics if another process creates the
        // target after the initial existence check.
        await link(temporary, target);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new CuratorError("OUTPUT_EXISTS", "输出文件已存在；确认替换时请使用 --force。");
        }
        throw error;
      }
      committed = true;
      try {
        await removeTemporary(temporary);
      } catch {
        throw outputCleanupError();
      }
    },
    async abort() {
      if (committed) return;
      let cleanupFailed = false;
      await closeHandle().catch(() => { cleanupFailed = true; });
      await removeTemporary(temporary).catch(() => { cleanupFailed = true; });
      if (cleanupFailed) throw outputCleanupError();
    },
  };
}
