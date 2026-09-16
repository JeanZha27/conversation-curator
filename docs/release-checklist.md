# Public release checklist

Do not publish while any required gate is blocked or failing.

## Local verification

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm benchmark:memory -- --items 50000 --max-rss-mib 256`
- `pnpm pack:check`
- `pnpm package:smoke`
- `pnpm compatibility:private`

The private compatibility command must use only `.private-test-data/conversations.json`. A missing
sample, zero classified items, or any failed item is a blocked gate. Do not attach its input to a
commit, release, issue, workflow artifact, or log.

## Repository verification

- Run Gitleaks against the complete Git history with redaction enabled.
- Confirm the GitHub Actions `Git history secret scan` and `verify` jobs pass on the intended default
  branch and on a pull request.
- Confirm branch protection requires both jobs before merge.
- Confirm GitHub private vulnerability reporting is enabled before directing reporters to it.
- Review the final release archive and confirm no private data, test fixture, temporary report,
  environment file, signing key, or credential is present.

The workflow checks out full history for Gitleaks and disables PR comments and SARIF artifact uploads
to keep findings out of public surfaces. Repositories owned by a GitHub organization may require a
`GITLEAKS_LICENSE` secret; configure it without printing its value.

## Release materials

- `LICENSE` declares Apache-2.0 and is present in the archive.
- `PRIVACY.md`, `SECURITY.md`, and `CONTRIBUTING.md` match the shipped behavior.
- The package installation smoke test completes the import–scan–export loop.
- Known limitations and unverified compatibility claims remain visible in `README.md`.

Creating the repository, committing, pushing, enabling branch protection, running GitHub-hosted CI,
and publishing are external actions and must be performed only with explicit authorization.
