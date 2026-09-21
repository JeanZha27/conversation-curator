# Contributing

Public contributions must preserve the local, privacy-first boundary.

## Never submit real conversation data

Do not commit or attach:

- ChatGPT, Claude, or Gemini export files;
- real conversation text or titles;
- access tokens, API keys, credentials, identity numbers, or customer names;
- reports or logs produced from private data.

Tests, issues, and pull requests must use clearly synthetic data. A reproducer that cannot be safely synthesized should use a private security-reporting channel.

An authorized, de-identified ChatGPT export may be used only for the local compatibility gate. Store it at `.private-test-data/conversations.json`; the directory is ignored by Git and excluded from the package. Never print, attach, rename into a tracked directory, or copy this file into an issue, test fixture, CI artifact, or test log.

## Local checks

Use Node.js 24 and pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark:memory -- --items 50000 --max-rss-mib 256
pnpm benchmark:input-limit
pnpm benchmark:large-items
pnpm pack:check
pnpm package:smoke
```

The separate real-format compatibility gate is intentionally local and is not part of public CI:

```bash
pnpm compatibility:private
```

A missing private sample is a blocked check, not a passing or skipped check. A synthetic fixture verifies only the compatibility harness and must not be reported as real-export compatibility evidence.

Pull requests should explain the changed user behavior, privacy impact, test evidence, and any unverified assumption. Do not weaken output validation, sensitive scanning, source-file immutability, or failure visibility to make tests pass.

## Review model

This is currently a single-maintainer repository. Pull requests provide a reviewable change record and enforce automated checks, but they do not by themselves constitute independent human review. Security-sensitive changes should explicitly record any external review obtained and must not describe automated or AI-assisted review as human third-party approval.

CI also scans complete Git history with Gitleaks. An intentional synthetic detector fixture may use
`gitleaks:allow` only after review and exact-line approval in the repository policy manifest. Never
suppress an entire test directory or use an allowlist for a real-looking value. The root Gitleaks
configuration contains only full-line historical synthetic fixtures; do not broaden it to a
directory, commit, rule, or generic credential shape.
The complete `.gitleaks.toml` is SHA-256 pinned in `scripts/approved-gitleaks-config.ts`.
Review every effective allowlist change before updating that digest; never regenerate it automatically.
When a marked fixture changes, verify the full new line contains only synthetic material before
updating its path-and-line SHA-256 digest in `scripts/approved-synthetic-markers.ts`. Do not
regenerate or approve all markers automatically; the digest change is a security review point.
The CI job downloads a pinned Gitleaks release and verifies its SHA-256 before scanning all Git
history. It neither comments on pull requests nor uploads a findings artifact.
