import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { CuratorError, inputSnapshotCleanupError } from "./errors.ts";

export const MAX_INPUT_BYTES = 256 * 1024 * 1024;

export type InputSnapshot = {
  path: string;
  sizeBytes: number;
  sha256: string;
  cleanup: () => Promise<void>;
};

function abortError(): Error {
  const error = new Error("操作已取消。");
  error.name = "AbortError";
  return error;
}

function sourceChanged(before: Stats, after: Stats, copiedBytes: number): boolean {
  return (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    copiedBytes !== after.size
  );
}

async function writeAll(handle: FileHandle, buffer: Buffer, length: number): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(buffer, offset, length - offset, null);
    if (bytesWritten === 0) {
      throw new CuratorError("INPUT_SNAPSHOT_FAILED", "无法创建稳定的输入快照。");
    }
    offset += bytesWritten;
  }
}

export async function createInputSnapshot(
  inputPath: string,
  signal?: AbortSignal,
): Promise<InputSnapshot> {
  const sourcePath = resolve(inputPath);
  if (extname(sourcePath).toLowerCase() !== ".json") {
    throw new CuratorError("INVALID_FILE_TYPE", "输入文件必须使用 .json 扩展名。");
  }
  if (signal?.aborted) throw abortError();

  let source: FileHandle;
  try {
    source = await open(sourcePath, "r");
  } catch {
    throw new CuratorError("INPUT_NOT_READABLE", "输入文件不存在或不可读取。");
  }

  let snapshotDirectory: string | null = null;
  let snapshot: FileHandle | null = null;
  let completed = false;
  try {
    const before = await source.stat();
    if (!before.isFile()) {
      throw new CuratorError("INPUT_NOT_FILE", "输入路径不是普通文件。");
    }
    if (before.size === 0) throw new CuratorError("INPUT_EMPTY", "输入文件为空。");
    if (before.size > MAX_INPUT_BYTES) {
      throw new CuratorError("INPUT_TOO_LARGE", "输入文件超过本轮 256 MiB 安全上限。");
    }

    snapshotDirectory = await mkdtemp(join(tmpdir(), "conversation-curator-input-"));
    const snapshotPath = join(snapshotDirectory, "snapshot.json");
    snapshot = await open(snapshotPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copiedBytes = 0;

    while (true) {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > MAX_INPUT_BYTES) {
        throw new CuratorError("INPUT_TOO_LARGE", "输入文件超过本轮 256 MiB 安全上限。");
      }
      await writeAll(snapshot, buffer, bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }

    if (signal?.aborted) throw abortError();
    const after = await source.stat();
    if (sourceChanged(before, after, copiedBytes)) {
      throw new CuratorError(
        "SOURCE_CHANGED_DURING_SNAPSHOT",
        "输入文件在创建只读快照时发生变化；请在文件稳定后重试。",
      );
    }
    await snapshot.sync();
    await snapshot.close();
    snapshot = null;
    completed = true;

    let cleaned = false;
    return {
      path: snapshotPath,
      sizeBytes: copiedBytes,
      sha256: hash.digest("hex"),
      cleanup: async () => {
        if (cleaned) return;
        try {
          await rm(snapshotDirectory!, { recursive: true, force: true });
          cleaned = true;
        } catch {
          throw inputSnapshotCleanupError();
        }
      },
    };
  } finally {
    let cleanupFailed = false;
    await snapshot?.close().catch(() => {
      cleanupFailed = true;
    });
    await source.close().catch(() => {
      cleanupFailed = true;
    });
    if (!completed && snapshotDirectory) {
      await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) throw inputSnapshotCleanupError();
  }
}
