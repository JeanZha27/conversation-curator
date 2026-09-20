import type { SecurityScan } from "../types.ts";

type Detector = {
  type: string;
  pattern: RegExp;
  validate?: (match: string) => boolean;
  prefilter?: (input: string) => boolean;
};

function includesAsciiCaseInsensitive(input: string, needle: string): boolean {
  const limit = input.length - needle.length;
  for (let start = 0; start <= limit; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      const inputCode = input.charCodeAt(start + offset);
      const needleCode = needle.charCodeAt(offset);
      const foldedInput = inputCode >= 65 && inputCode <= 90 ? inputCode + 32 : inputCode;
      const foldedNeedle = needleCode >= 65 && needleCode <= 90 ? needleCode + 32 : needleCode;
      if (foldedInput !== foldedNeedle) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function containsDigit(input: string): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 48 && code <= 57) return true;
  }
  return false;
}

const HARD_DETECTORS: Detector[] = [
  {
    type: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/giu, // gitleaks:allow -- detector signature only
    prefilter: (input) => includesAsciiCaseInsensitive(input, "private key"),
  },
  {
    type: "API_KEY",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|A[KS]IA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu,
    prefilter: (input) => ["sk-", "AKIA", "ASIA", "gh", "github_pat_", "glpat-", "npm_", "hf_", "AIza", "sk_live_", "rk_live_", "xox"].some((hint) => input.includes(hint)),
  },
  {
    type: "ACCESS_TOKEN",
    pattern: /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{12,}|Basic\s+[A-Za-z0-9+/]{8,}={0,2})/giu,
    prefilter: (input) =>
      includesAsciiCaseInsensitive(input, "bearer ") ||
      includesAsciiCaseInsensitive(input, "basic "),
  },
  {
    type: "PASSWORD_FIELD",
    pattern: /(?:\b(?:[A-Z0-9]+_)*(?:PASSWORD|PASSWD|PWD|API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|SECRET(?:[_-]?ACCESS)?[_-]?KEY)|密码)\s*[:=]\s*(?:"[^"\r\n]{1,}"|'[^'\r\n]{1,}'|[^\s,;"']{1,})/giu,
    prefilter: (input) =>
      input.includes("密码") ||
      // Every regex branch contains one of these stems, including its no-separator form.
      ["password", "passwd", "pwd", "api", "access", "client", "secret"]
        .some((hint) => includesAsciiCaseInsensitive(input, hint)),
  },
  {
    type: "SESSION_CREDENTIAL",
    pattern: /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/giu,
    prefilter: (input) => includesAsciiCaseInsensitive(input, "cookie"),
  },
  {
    type: "CONNECTION_CREDENTIAL",
    pattern: /\b[A-Z][A-Z0-9+.-]{1,15}:\/\/[^/\s:@]+:[^@\s/]+@[^\s]+/giu,
    prefilter: (input) => input.includes("://") && input.includes("@"),
  },
  {
    type: "CN_ID",
    pattern: /\b\d{17}[\dXx]\b/gu,
    validate: isValidChineseIdentityNumber,
    prefilter: containsDigit,
  },
  {
    type: "BANK_CARD",
    pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu,
    validate: isLuhnValid,
    prefilter: containsDigit,
  },
];

function isValidChineseIdentityNumber(value: string): boolean {
  const normalized = value.toUpperCase();
  if (!/^\d{17}[\dX]$/u.test(normalized)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const sum = weights.reduce((total, weight, index) => total + Number(normalized[index]) * weight, 0);
  return checks[sum % 11] === normalized[17];
}

function isLuhnValid(value: string): boolean {
  const digits = value.replace(/[ -]/gu, "");
  if (!/^\d{13,19}$/u.test(digits) || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function shannonEntropy(
  counts: Uint32Array<ArrayBuffer>,
  touchedCodes: readonly number[],
  length: number,
): number {
  let entropy = 0;
  for (const code of touchedCodes) {
    const count = counts[code]!;
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isCandidateCharacter(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 45 ||
    code === 47 ||
    code === 61 ||
    code === 95
  );
}

function highEntropyCandidateSpans(value: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let start = -1;
  const counts = new Uint32Array(128);
  const touchedCodes: number[] = [];

  const finish = (end: number): void => {
    if (start === -1) return;
    if (end - start >= 32 && touchedCodes.length >= 10) {
      if (shannonEntropy(counts, touchedCodes, end - start) >= 4.2) spans.push([start, end]);
    }
    start = -1;
    for (const code of touchedCodes) counts[code] = 0;
    touchedCodes.length = 0;
  };

  for (let index = 0; index <= value.length; index += 1) {
    const code = index < value.length ? value.charCodeAt(index) : -1;
    if (isCandidateCharacter(code)) {
      if (start === -1) start = index;
      if (counts[code] === 0) touchedCodes.push(code);
      counts[code] = (counts[code] ?? 0) + 1;
    } else {
      finish(index);
    }
  }
  return spans;
}

function increment(counts: Record<string, number>, type: string): void {
  counts[type] = (counts[type] ?? 0) + 1;
}

export function scanSensitiveText(input: string): SecurityScan {
  const matchCounts: Record<string, number> = {};
  let redactedText = input;

  for (const detector of HARD_DETECTORS) {
    if (detector.prefilter && !detector.prefilter(redactedText)) continue;
    detector.pattern.lastIndex = 0;
    if (!detector.pattern.test(redactedText)) {
      detector.pattern.lastIndex = 0;
      continue;
    }
    detector.pattern.lastIndex = 0;
    redactedText = redactedText.replace(detector.pattern, (match) => {
      if (detector.validate && !detector.validate(match)) return match;
      increment(matchCounts, detector.type);
      return `[REDACTED:${detector.type}]`;
    });
  }

  const candidateSpans = highEntropyCandidateSpans(redactedText);
  const candidateMatch = candidateSpans.length > 0;
  if (candidateMatch) {
    const parts: string[] = [];
    let cursor = 0;
    for (const [start, end] of candidateSpans) {
      parts.push(redactedText.slice(cursor, start), "[REDACTED:HIGH_ENTROPY_CANDIDATE]");
      cursor = end;
      increment(matchCounts, "HIGH_ENTROPY_CANDIDATE");
    }
    parts.push(redactedText.slice(cursor));
    redactedText = parts.join("");
  }

  const hardMatch = Object.keys(matchCounts).some((type) => type !== "HIGH_ENTROPY_CANDIDATE");
  const riskFlags = [
    ...(hardMatch ? ["SENSITIVE_PATTERN"] : []),
    ...(candidateMatch ? ["S3_CANDIDATE"] : []),
  ];

  return {
    sensitivityLevel: hardMatch ? "S3" : candidateMatch ? "S2" : "S0",
    hardMatch,
    candidateMatch,
    riskFlags,
    matchCounts,
    redactedText,
  };
}

export function scanSensitiveSegments(inputs: readonly string[]): SecurityScan {
  const matchCounts: Record<string, number> = {};
  let hardMatch = false;
  let candidateMatch = false;

  for (const input of inputs) {
    const scan = scanSensitiveText(input);
    hardMatch ||= scan.hardMatch;
    candidateMatch ||= scan.candidateMatch;
    for (const [type, count] of Object.entries(scan.matchCounts)) {
      matchCounts[type] = (matchCounts[type] ?? 0) + count;
    }
  }

  return {
    sensitivityLevel: hardMatch ? "S3" : candidateMatch ? "S2" : "S0",
    hardMatch,
    candidateMatch,
    riskFlags: [
      ...(hardMatch ? ["SENSITIVE_PATTERN"] : []),
      ...(candidateMatch ? ["S3_CANDIDATE"] : []),
    ],
    matchCounts,
    // The pipeline classifies a separately bounded and privacy-sanitized
    // context, so retaining a second full redacted copy is unnecessary.
    redactedText: "",
  };
}
