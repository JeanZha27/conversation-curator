# Security policy

## Supported version

Only the latest commit on the default branch is intended to receive security fixes before the first public release. No production-ready or compliance guarantee is made.

## Reporting a vulnerability

Once this repository is public and GitHub private vulnerability reporting is enabled, use its
**Report a vulnerability** form. Do not open a public issue containing an export file,
conversation text, access token, personal data, sensitive report, or unredacted log.

Until that private reporting form is visibly available, do not submit security-sensitive details
to this repository. The release procedure must enable and verify the form before the public
repository is announced or shared.

## Trust boundaries

- Exported conversation content and classifier output are untrusted input.
- The source export is read-only.
- The default path has no network or telemetry capability.
- Deterministic scanning precedes classification.
- Source IDs become one-way local references before output.
- All output strings receive a final sensitive-data scan.
- Hard-rule `S3` results cannot be lowered by a classifier.
- Failed or cancelled output is not committed; temporary-file cleanup failures are surfaced explicitly instead of being reported as success.

## Known limitations

- Rule-based scanning can miss unknown secret formats and contextual personal data.
- The current adapter passed one locally held, de-identified real-export structure; other export variants remain unverified.
- The local machine, selected output directory, terminal history, and operating-system backups remain outside the application's control.
