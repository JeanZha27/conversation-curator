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
pnpm pack:check
pnpm package:smoke
```

The separate real-format compatibility gate is intentionally local and is not part of public CI:

```bash
pnpm compatibility:private
```

A missing private sample is a blocked check, not a passing or skipped check. A synthetic fixture verifies only the compatibility harness and must not be reported as real-export compatibility evidence.

Pull requests should explain the changed user behavior, privacy impact, test evidence, and any unverified assumption. Do not weaken output validation, sensitive scanning, source-file immutability, or failure visibility to make tests pass.

CI also scans complete Git history with Gitleaks. Intentional synthetic detector fixtures must be
clearly marked on the same line with `gitleaks:allow`; never suppress an entire test directory or use
an allowlist for a real-looking value. Organization-owned repositories may need a private
`GITLEAKS_LICENSE` repository secret for the Action to run.
