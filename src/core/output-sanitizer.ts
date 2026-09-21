import { createHash } from "node:crypto";
import { CuratorError } from "./errors.ts";
import { scanSensitiveText } from "./security-scanner.ts";

export type Sanitized<T> = {
  value: T;
  findings: number;
};

type OutputDetector = {
  type: string;
  pattern: RegExp;
  validate?: (match: string, offset: number, input: string) => boolean;
  redactWholeLine?: boolean;
};

function isAllowedNetworkUrlPath(offset: number, input: string): boolean {
  const prefix = input.slice(0, offset);
  return (
    /[A-Z][A-Z0-9+.-]*:\/\/[^\s"'<>]*$/iu.test(prefix) ||
    /(?:^|[\s("'\[{])\/\/[^\s"'<>]*$/u.test(prefix)
  );
}

function isAsciiSchemeFragment(match: string, offset: number, input: string): boolean {
  if (match[2] !== "/" || input[offset + 3] !== "/") return false;
  const prefix = input.slice(0, offset).match(/[A-Z][A-Z0-9+.-]*$/iu)?.[0] ?? "";
  const driveLetter = match[0] ?? "";
  // Treat every ASCII <scheme>:// prefix as a network URL. This deliberately
  // includes drive-like C:// text; ordinary C:/ and C:\\ paths remain covered.
  return /^[A-Z][A-Z0-9+.-]*$/iu.test(`${prefix}${driveLetter}`);
}

function isCompactCjkChoiceList(match: string, offset: number, input: string): boolean {
  const leading = input.slice(0, offset).match(/\p{Script=Han}+$/u)?.[0] ?? "";
  if ([...leading].length !== 1) return false;
  const options = match.slice(1).split("/");
  return options.length >= 2 && options.every((option) => /^\p{Script=Han}{1,2}$/u.test(option));
}

function isPosixAbsolutePath(match: string, offset: number, input: string): boolean {
  if (isAllowedNetworkUrlPath(offset, input)) return false;
  const previous = input[offset - 1] ?? "";
  if (!/[\p{L}\p{N}]/u.test(previous)) return true;
  // The regex boundary already excludes ASCII relative paths such as
  // project/home/page. Treat 男/女/其他-style compact CJK choices as text;
  // this also exempts any one-Han-character prefix with only 1-2-character
  // segments. Other CJK-adjacent known roots and multi-level paths stay covered.
  if (isCompactCjkChoiceList(match, offset, input)) return false;
  return (
    /^\/(?:Applications|Library|System|Users|Volumes|bin|dev|etc|home|opt|private|root|run|sbin|srv|tmp|usr|var)(?:\/|$)/u.test(match) ||
    match.indexOf("/", 1) >= 0
  );
}

// Output boundaries need broader privacy protection than the classifier's
// high-risk scanner. These patterns intentionally cover common PII and local
// paths even when they do not warrant an S3 content classification.
const OUTPUT_PRIVACY_DETECTORS: OutputDetector[] = [
  {
    type: "EMAIL",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    type: "CN_MOBILE",
    pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu,
  },
  {
    type: "PHONE_NUMBER",
    pattern: /(?<![\d+])(?:\+\d[\d ().-]{5,}\d|00\d[\d ().-]{5,}\d|0\d[\d ().-]{5,}\d|\(\d{2,4}\)[\d ().-]{4,}\d|[2-9]\d{2}[. -]\d{3}[. -]\d{4})(?!\d)/gu,
    validate: (match) => {
      const digits = match.replace(/\D/gu, "");
      const normalized = match.trim();
      const significantDigits = normalized.startsWith("00") ? digits.slice(2) : digits;
      if (significantDigits.length < 8 || significantDigits.length > 15) return false;
      if (/^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/u.test(normalized)) {
        return false;
      }
      if (
        normalized.startsWith("00") &&
        !/^00[1-9]\d{7,14}$/u.test(normalized) &&
        !/^00[1-9]\d{0,2}[ ().-]/u.test(normalized)
      ) {
        return false;
      }
      if (
        /^0\d/u.test(normalized) &&
        !normalized.startsWith("00") &&
        (!/[ ().-]/u.test(normalized) || digits.length < 9)
      ) {
        return false;
      }
      return true;
    },
  },
  {
    type: "LOCAL_FILE_URI",
    pattern: /(?<![A-Z0-9_])file:\/\/[^\r\n"'<>]*/giu,
    redactWholeLine: true,
  },
  {
    type: "CJK_PATH_CUE",
    pattern: /(?:路径|文件|目录|位置)(?:是|为|在)?\s*\/(?:[^/\s"'<>\r\n]+(?:\/[^/\s"'<>\r\n]+)+)/gu,
    redactWholeLine: true,
  },
  {
    type: "POSIX_ABSOLUTE_PATH",
    // HTTP(S) and protocol-relative URLs are allowed. Local paths are
    // whole-line redacted so spaces cannot leave trailing path components.
    pattern: /(?<![A-Z0-9._~/-])\/(?:[^/\s"'<>\r\n]+(?:\/[^/\s"'<>\r\n]+)*)/giu,
    validate: isPosixAbsolutePath,
    redactWholeLine: true,
  },
  {
    type: "WINDOWS_ABSOLUTE_PATH",
    pattern: /(?:[A-Z]:[\\/]|\\\\)[^\r\n]*/giu,
    validate: (match, offset, input) => !isAsciiSchemeFragment(match, offset, input),
    redactWholeLine: true,
  },
];

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
  let sanitizedValue = scan.redactedText;
  let findings = Object.values(scan.matchCounts).reduce((total, count) => total + count, 0);

  for (const detector of OUTPUT_PRIVACY_DETECTORS) {
    detector.pattern.lastIndex = 0;
    if (!detector.pattern.test(sanitizedValue)) {
      detector.pattern.lastIndex = 0;
      continue;
    }
    if (detector.redactWholeLine) {
      sanitizedValue = sanitizedValue
        .split(/(\r?\n)/u)
        .map((line) => {
          if (/^\r?\n$/u.test(line)) return line;
          let lineMatched = false;
          detector.pattern.lastIndex = 0;
          line.replace(detector.pattern, (match, offset, input) => {
            if (detector.validate && !detector.validate(match, offset, input)) return match;
            lineMatched = true;
            findings += 1;
            return match;
          });
          return lineMatched ? `[REDACTED:${detector.type}]` : line;
        })
        .join("");
      continue;
    }

    detector.pattern.lastIndex = 0;
    sanitizedValue = sanitizedValue.replace(detector.pattern, (match, offset, input) => {
      if (detector.validate && !detector.validate(match, offset, input)) return match;
      findings += 1;
      return `[REDACTED:${detector.type}]`;
    });
  }

  return {
    value: sanitizedValue,
    findings,
  };
}

export function sanitizeClassificationContext(value: string): string {
  return sanitizeOutputString(value).value.replace(/\[REDACTED:[A-Z0-9_]+\]/gu, " ");
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
      if (sanitizeOutputString(current).findings > 0) unsafePaths.push(path);
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
  return assessOutputSafety(value).unsafe;
}

export function assertOutputValueSafe(value: unknown): void {
  const assessment = assessOutputSafety(value);
  if (assessment.unsafe) {
    throw new CuratorError(
      "OUTPUT_SANITIZATION_FAILED",
      assessment.unsafePaths.length > 0
        ? `最终输出安全扫描失败（${assessment.unsafePaths.slice(0, 3).join("、")}）。`
        : "最终序列化输出安全扫描失败。",
    );
  }
}

function assessOutputSafety(value: unknown): {
  unsafe: boolean;
  unsafePaths: string[];
} {
  const unsafePaths = sensitiveOutputPaths(value);
  const serializedUnsafe = sanitizeOutputString(JSON.stringify(value)).findings > 0;
  return {
    unsafe: unsafePaths.length > 0 || serializedUnsafe,
    unsafePaths,
  };
}
