# Changelog

## Unreleased

- Added the end-user Codex Skill entrypoint and a CLI summary mode that limits tool output to aggregate counts.
- Verified structural compatibility with a locally held, de-identified copy of a real ChatGPT export; the copy is excluded from Git and release packages.
- Closed credential-prefilter gaps so declared hard-secret formats receive the required S3 treatment.
- Scan duplicate-ID items before skipping classification, and report any duplicate run as partial.
- Restricted inline secret-scan exemptions to reviewed exact lines, narrowed historical Gitleaks allowlisting, and pinned CI Actions to verified commits.
- Pinned the complete Gitleaks configuration so an added allowlist pattern cannot silently bypass the repository policy.

## 0.1.0 — initial local prototype (not publicly released)

- Added read-only, offline ChatGPT export classification with deterministic sensitive-data scanning.
- Added explicit, streamed JSON report export and local validation checks.
