# Public release checklist

Use this checklist before publishing a source release or package. A required check that is missing,
blocked, or failing stops the release.

## Local checks

- Validate `SKILL.md` frontmatter and confirm its scope matches the README and CLI.
- Test one matching Skill request and one unrelated request in a clean Codex installation.
- Confirm the Skill gives the user a placeholder-based `--summary-only` command instead of running it, and asks for aggregate output only.
- Confirm README, Privacy, and Skill text state that local filesystem access is outside the CLI's isolation boundary.
- `pnpm install --frozen-lockfile`
- `pnpm policy:repository`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm benchmark:memory -- --items 50000 --max-rss-mib 256`
- `pnpm benchmark:input-limit`
- `pnpm benchmark:large-items`
- `pnpm benchmark:mapping-nodes`
- `pnpm pack:check`
- `pnpm package:smoke`
- `pnpm compatibility:private`

The private compatibility check reads only `.private-test-data/conversations.json`. Its input must
never be committed, attached to an issue, uploaded as a workflow artifact, or copied into a log. A
missing sample, zero classified items, or any failed item blocks the release.

## Repository checks

- Scan the complete Git history with the pinned, checksum-verified Gitleaks version and redaction
  enabled.
- Review every Gitleaks exception as an exact synthetic fixture. Do not allowlist a directory,
  commit, detector rule, or generic credential pattern.
- Require the GitHub Actions checks `Git history secret scan` and `verify` on pull requests and the
  default branch.
- Keep the `main` ruleset active: pull request required, branch current before merge, deletion and
  force-push blocked, and no bypass actor.
- Keep private vulnerability reporting enabled and confirm the repository exposes a private report
  form.
- Review the final archive for private exports, reports, temporary files, environment files,
  credentials, signing material, and generated logs.
- Confirm public commit names and noreply addresses are intentional.
- Have a non-author reviewer follow the README in a clean environment and exercise invalid input,
  repeated execution, cancellation, and report-write failure.
- Record review provenance. If no non-author human review was obtained, state that boundary and do
  not describe automated or AI-assisted analysis as independent approval.

The secret-scan workflow checks out full history and produces no pull-request comment or uploaded
findings artifact.

## Release contents

- `LICENSE` declares Apache-2.0.
- `README.md` and `README.en.md` describe the shipped behavior.
- `SKILL.md`, `CHANGELOG.md`, `PRIVACY.md`, `SECURITY.md`, and `CONTRIBUTING.md` are included.
- The installed-package smoke test completes the import, scan, and export loop.
- Known limitations and unverified compatibility claims remain visible.
- A human maintainer approves the release.
- The release commit has passed required `main` checks, the annotated `vMAJOR.MINOR.PATCH` tag is
  cryptographically signed and passes `git verify-tag`, and the GitHub Release points to that exact
  tag and links the passing CI run.
- `GOVERNANCE.md` still matches repository ownership, support status, and publication scope.

## Verified public baseline — 2026-09-21

- The public repository has private vulnerability reporting enabled.
- The active `Protect main` ruleset requires pull requests, current branches, `Git history secret
  scan`, and `verify`; it blocks deletion and force pushes and has no bypass actor.
- GitHub-hosted checks passed on protected pull requests and again on `main` after merge.
- The initial hosted secret-scan setup error is superseded by the checksum-verified Gitleaks v8.30.0
  workflow. Its historical test-only private-key header exception is pinned to one exact
  commit/file/rule/line fingerprint.
- Local verification passed repository policy, strict type-checking, 56 regression tests,
  production build, package dry-run, installed-package smoke testing, and the private
  de-identified compatibility check (22/22 classified).
- Synthetic memory benchmarks stayed below the 256 MiB project threshold for 50,000 items, an
  approximately 249 MiB input, and 30 near-limit conversation objects.
- Independent public due diligence findings covering cancellation, classification-marker
  isolation, URI and local-path handling, privacy-state simplification, CI evidence, and confidence
  constants were fixed and verified in pull request #3.

## Review boundaries

- Sensitive-data detection is rule-based and cannot guarantee that every private value is found.
- Local compatibility and memory checks were run on macOS; hosted checks run on Ubuntu. Windows is
  not yet verified.
- Reviews included automated and AI-assisted analysis, but not an independent human security audit.
- Compatibility evidence covers one locally held, de-identified export structure, not every
  ChatGPT export version.
- Public source availability is not a claim of universal compatibility, zero privacy risk, or a
  package-registry release.

Detailed intermediate investigation logs are preserved in Git history and merged pull requests
rather than repeated here. Keep this file focused on the current gates, verified baseline, and
remaining limitations.
