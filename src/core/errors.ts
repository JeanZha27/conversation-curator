export class CuratorError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "CuratorError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function outputCleanupError(): CuratorError {
  return new CuratorError(
    "OUTPUT_CLEANUP_FAILED",
    "临时报告清理失败；请在输出目录中手动删除隐藏的 .tmp 报告文件。",
  );
}
