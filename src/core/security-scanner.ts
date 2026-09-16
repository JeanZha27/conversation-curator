import type { SecurityScan } from "../types.ts";

type Detector = {
  type: string;
  pattern: RegExp;
  validate?: (match: string) => boolean;
};

const HARD_DETECTORS: Detector[] = [
  {
    type: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/giu,
  },
  {
    type: "API_KEY",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b/gu,
  },
  {
    type: "ACCESS_TOKEN",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/giu,
  },
  {
    type: "PASSWORD_FIELD",
    pattern: /(?:\b(?:password|passwd|pwd)|密码)\s*[:=]\s*[^\s,;]{4,}/giu,
  },
  {
    type: "CN_ID",
    pattern: /\b\d{17}[\dXx]\b/gu,
    validate: isValidChineseIdentityNumber,
  },
  {
    type: "BANK_CARD",
    pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu,
    validate: isLuhnValid,
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

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function increment(counts: Record<string, number>, type: string): void {
  counts[type] = (counts[type] ?? 0) + 1;
}

export function scanSensitiveText(input: string): SecurityScan {
  const matchCounts: Record<string, number> = {};
  let redactedText = input;

  for (const detector of HARD_DETECTORS) {
    detector.pattern.lastIndex = 0;
    redactedText = redactedText.replace(detector.pattern, (match) => {
      if (detector.validate && !detector.validate(match)) return match;
      increment(matchCounts, detector.type);
      return `[REDACTED:${detector.type}]`;
    });
  }

  let candidateMatch = false;
  const candidatePattern = /\b[A-Za-z0-9+/_=-]{32,}\b/gu;
  redactedText = redactedText.replace(candidatePattern, (match) => {
    if (new Set(match).size < 10 || shannonEntropy(match) < 4.2) return match;
    candidateMatch = true;
    increment(matchCounts, "HIGH_ENTROPY_CANDIDATE");
    return "[REDACTED:HIGH_ENTROPY_CANDIDATE]";
  });

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
