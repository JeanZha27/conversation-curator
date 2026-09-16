# Security policy

## Supported version

Only the latest commit on the default branch is intended to receive security fixes before the first public release. No production-ready or compliance guarantee is made.

## Reporting a vulnerability

After the GitHub repository is created, report vulnerabilities through a private GitHub Security Advisory. Do not open a public issue containing an export file, conversation text, access token, personal data, sensitive report, or unredacted log.

Until a private reporting channel exists, public release remains blocked.

## Trust boundaries

- Exported conversation content and classifier output are untrusted input.
- The source export is read-only.
- The default path has no network or telemetry capability.
- Deterministic scanning precedes classification.
- Source IDs become one-way local references before output.
- All output strings receive a final sensitive-data scan.
- Hard-rule `S3` results cannot be lowered by a classifier.
- Failed or cancelled output remains in a temporary file that is removed rather than committed.

## Known limitations

- Rule-based scanning can miss unknown secret formats and contextual personal data.
- The current adapter has only synthetic compatibility coverage.
- The local machine, selected output directory, terminal history, and operating-system backups remain outside the application's control.
