import { createHash } from "node:crypto";

// Pin the entire reviewed config, not just its inline suppression markers.
// Any edit requires reviewing the effective Gitleaks allowlist before updating this digest.
const APPROVED_CONFIG_SHA256 = "6be2130914ce66682ce90770140ed560c3793afb22da134931ad42ebc85bcc92";

export function isApprovedGitleaksConfig(content: string): boolean {
  return createHash("sha256").update(content, "utf8").digest("hex") === APPROVED_CONFIG_SHA256;
}
