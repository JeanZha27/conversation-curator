# Changelog

## Unreleased

- Bound complete-item JSON complexity before parsing; reject POSIX FIFOs without blocking and supervise worker diagnostics and temporary-file cleanup.
- Scan quoted credential fields, authentication whitespace, and both independent and concatenated message parts. Preserve numeric risk counters without treating them as secret assignments.
- Treat negated or conflicting lifecycle cues as uncertain; recognize both supported conversation ID fields in repository artifact checks.
- Clarify raw temporary snapshots, crash boundaries, installed-package commands, and character-based context limits. Report schema remains `1.4`; new structure-limit and worker-failure error codes are additive. Inputs within the old byte limit can now be rejected for excessive complexity.

- Capture input through one bounded, mode-`0600` snapshot; cap mapping nodes before fallback sorting;
  and expose deterministic cross-run linkage in the report privacy metadata.
- Define single-maintainer governance, review provenance, signed-release requirements, CODEOWNERS,
  and monthly dependency update proposals without claiming independent human review.
- Made the Codex Skill use a human-run relay, documented the filesystem threat boundary, and reject unrelated JSON before full-file processing.
- Aligned bilingual operational details and preserved complete `main` CI runs while still cancelling superseded branch runs.
- Added an English README, beginner-friendly usage introductions, and complete repository/package discovery metadata.
- Reduced release documentation to current gates and evidence, and stopped treating compact Chinese choice lists as local paths.
- Preserve cancellation errors during streamed UTF-8 decoding and add read-time cancellation coverage.
- Keep redaction markers out of classification and tighten URI and non-ASCII local-path handling.
- Simplify the successful-report privacy invariant and centralize classification confidence policy.
- Correct hosted-CI evidence and bound workflow concurrency and job duration.
- Added the end-user Codex Skill entrypoint and a CLI summary mode that limits tool output to aggregate counts.
- Verified structural compatibility with a locally held, de-identified copy of a real ChatGPT export; the copy is excluded from Git and release packages.
- Closed credential-prefilter gaps so declared hard-secret formats receive the required S3 treatment.
- Scan duplicate-ID items before skipping classification, and report any duplicate run as partial.
- Restricted inline secret-scan exemptions to reviewed exact lines, narrowed historical Gitleaks allowlisting, and pinned CI Actions to verified commits.
- Pinned the complete Gitleaks configuration so an added allowlist pattern cannot silently bypass the repository policy.

## 0.1.0 — initial local prototype (not published to a package registry)

- Added read-only, offline ChatGPT export classification with deterministic sensitive-data scanning.
- Added explicit, streamed JSON report export and local validation checks.
