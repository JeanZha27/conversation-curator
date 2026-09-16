import { createHash } from "node:crypto";
import { CuratorError } from "./errors.ts";
import { scanSensitiveText } from "./security-scanner.ts";

export type Sanitized<T> = {
  value: T;
  findings: number;
};

function groupedDigest(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return digest.match(/.{1,8}/gu)!.join(":");
}

export function safeConversationReference(sourceId: string): string {
  return `conv:${groupedDigest(`chatgpt:${sourceId}`)}`;
}

export function safeSourceHash(hash: string): string {
  return `sha256:${hash.match(/.{1,8}/gu)!.join(":")}`;
}

export function sanitizeOutputString(value: string): Sanitized<string> {
  const scan = scanSensitiveText(value);
  return {
    value: scan.redactedText,
    findings: Object.values(scan.matchCounts).reduce((total, count) => total + count, 0),
  };
}

export function sanitizeOutputValue<T>(value: T): Sanitized<T> {
  let findings = 0;

  function visit(current: unknown): unknown {
    if (typeof current === "string") {
      const sanitized = sanitizeOutputString(current);
      findings += sanitized.findings;
      return sanitized.value;
    }
    if (Array.isArray(current)) return current.map(visit);
    if (typeof current === "object" && current !== null) {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [key, visit(entry)]),
      );
    }
    return current;
  }

  return { value: visit(value) as T, findings };
}

function sensitiveOutputPaths(value: unknown): string[] {
  const unsafePaths: string[] = [];

  function visit(current: unknown, path: string): void {
    if (typeof current === "string") {
      const scan = scanSensitiveText(current);
      if (scan.hardMatch || scan.candidateMatch) unsafePaths.push(path);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (typeof current === "object" && current !== null) {
      for (const [key, entry] of Object.entries(current)) visit(entry, `${path}.${key}`);
    }
  }

  visit(value, "output");
  return unsafePaths;
}

export function outputValueHasSensitiveData(value: unknown): boolean {
  return sensitiveOutputPaths(value).length > 0;
}

export function assertOutputValueSafe(value: unknown): void {
  const unsafePaths = sensitiveOutputPaths(value);
  if (unsafePaths.length > 0) {
    throw new CuratorError(
      "OUTPUT_SANITIZATION_FAILED",
      `最终输出安全扫描失败（${unsafePaths.slice(0, 3).join("、")}）。`,
    );
  }
}
