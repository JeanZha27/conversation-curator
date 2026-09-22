import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { sanitizeOutputString } from "./output-sanitizer.ts";

export const BOUNDED_HEAP_FLAGS = ["--max-old-space-size=96", "--max-semi-space-size=2"] as const;

function write(channel: "stdout" | "stderr", value: string): void {
  process[channel].write(sanitizeOutputString(value).value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Owns only this worker's temporary directory and registered report file.
 * Native worker diagnostics are discarded; application output uses typed IPC.
 * If the supervisor itself is forcibly killed, OS-level cleanup is not assured.
 */
export async function superviseCli(entryPath: string, argv: string[], outputPath: string | null): Promise<number> {
  let temporaryRoot: string;
  try {
    temporaryRoot = await mkdtemp(join(tmpdir(), "conversation-curator-run-"));
  } catch {
    write("stderr", "错误 [CLI_START_FAILED]：无法创建本次运行的临时目录。\n");
    return 1;
  }
  const temporaryReports = new Set<string>();
  let interrupted = false;
  let completion: number | null = null;
  let exitCode = 1;
  try {
    exitCode = await new Promise<number>((resolveExitCode) => {
      let failedToStart = false;
      const child = spawn(process.execPath, [...BOUNDED_HEAP_FLAGS, entryPath, ...argv], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      // Native errors can contain local paths and unredacted runtime state.
      child.stdout?.resume();
      child.stderr?.resume();
      const cancel = () => { interrupted = true; child.kill("SIGINT"); };
      process.on("SIGINT", cancel);
      child.once("spawn", () => {
        child.send({ type: "start", temporaryRoot }, error => {
          if (error) child.kill("SIGKILL");
        });
      });
      child.on("message", (message: unknown) => {
        if (!record(message)) return;
        if (message.type === "output" && (message.channel === "stdout" || message.channel === "stderr") &&
          typeof message.value === "string" && message.value.length <= 64 * 1024) {
          write(message.channel, message.value);
        } else if (message.type === "complete" && typeof message.exitCode === "number" &&
          [0, 1, 2, 130].includes(message.exitCode)) {
          completion = message.exitCode;
        } else if (message.type === "temporary-report") {
          const path = message.path;
          const target = outputPath ? resolve(outputPath) : null;
          const prefix = target ? `.${basename(target)}.${child.pid}.` : "";
          if (typeof path !== "string" || !target || !isAbsolute(path) ||
            dirname(path) !== dirname(target) || !basename(path).startsWith(prefix) ||
            !/^[a-f0-9-]{36}\.tmp$/u.test(basename(path).slice(prefix.length)) ||
            temporaryReports.size !== 0) {
            child.kill("SIGKILL");
            return;
          }
          // Register before the worker opens the file, so a fatal error at any
          // later point cannot leave an unowned raw report fragment.
          temporaryReports.add(path);
          child.send({ type: "temporary-registered" }, error => {
            if (error) child.kill("SIGKILL");
          });
        }
      });
      child.once("error", () => {
        failedToStart = true;
        process.removeListener("SIGINT", cancel);
        write("stderr", "错误 [CLI_START_FAILED]：无法启动处理进程。\n");
        resolveExitCode(1);
      });
      child.once("close", (code, signal) => {
        process.removeListener("SIGINT", cancel);
        if (failedToStart) return;
        if (completion !== null && code === completion && signal === null) {
          resolveExitCode(completion);
        } else if (interrupted || signal === "SIGINT") {
          write("stderr", "操作已取消；正在清理本次临时文件。\n");
          resolveExitCode(130);
        } else {
          write("stderr", "错误 [CLI_WORKER_FAILED]：处理进程异常结束；请缩小输入后重试并检查本次结果。\n");
          resolveExitCode(1);
        }
      });
    });
  } finally {
    let reportCleanupFailed = false;
    for (const path of temporaryReports) {
      await rm(path, { force: true }).catch(() => { reportCleanupFailed = true; });
    }
    let inputCleanupFailed = false;
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => { inputCleanupFailed = true; });
    if (reportCleanupFailed) {
      write("stderr", "错误 [OUTPUT_CLEANUP_FAILED]：临时报告清理失败；请检查输出目录中的隐藏 .tmp 文件。\n");
      exitCode = 1;
    }
    if (inputCleanupFailed) {
      write("stderr", "错误 [INPUT_SNAPSHOT_CLEANUP_FAILED]：输入快照清理失败；请检查系统临时目录中的 conversation-curator-run-* 目录。\n");
      exitCode = 1;
    }
  }
  return exitCode;
}

export function registerWorkerReport(path: string): Promise<void> {
  return new Promise((resolveRegistered, reject) => {
    const cleanup = () => {
      process.removeListener("message", receive);
      process.removeListener("disconnect", disconnected);
    };
    const disconnected = () => { cleanup(); reject(new Error("Worker supervisor disconnected")); };
    const receive = (message: unknown) => {
      if (record(message) && message.type === "temporary-registered") {
        cleanup();
        resolveRegistered();
      }
    };
    process.on("message", receive);
    process.once("disconnect", disconnected);
    if (!process.connected || !process.send) { disconnected(); return; }
    process.send({ type: "temporary-report", path }, error => {
      if (error) disconnected();
    });
  });
}

export function workerTemporaryRoot(message: unknown): string | null {
  return record(message) && message.type === "start" && typeof message.temporaryRoot === "string" &&
    isAbsolute(message.temporaryRoot) ? message.temporaryRoot : null;
}
