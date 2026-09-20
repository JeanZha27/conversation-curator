// One reviewed synthetic header in the immutable initial private Git history.
// A fingerprint is commit/file/rule/line-specific, unlike a rule or path allowlist.
const APPROVED_IGNORE =
  "4e1928b8bde980876b1245df10da4a0ad804810b:test/core.test.ts:private-key:121\n";

export function isApprovedGitleaksIgnore(content: string): boolean {
  return content === APPROVED_IGNORE;
}
