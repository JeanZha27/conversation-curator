# Public release checklist

Do not publish while any required gate is blocked or failing.

## Local verification

- Validate `SKILL.md` frontmatter and compare its scope with README and CLI behavior.
- In a clean Codex installation, check one matching request and one unrelated request for correct Skill selection.
- Verify the Skill's summary mode exposes only counts to the Codex conversation; inspect any detailed report locally.
- `pnpm install --frozen-lockfile`
- `pnpm policy:repository`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm benchmark:memory -- --items 50000 --max-rss-mib 256`
- `pnpm benchmark:input-limit`
- `pnpm benchmark:large-items`
- `pnpm pack:check`
- `pnpm package:smoke`
- `pnpm compatibility:private`

The private compatibility command must use only `.private-test-data/conversations.json`. A missing
sample, zero classified items, or any failed item is a blocked gate. Do not attach its input to a
commit, release, issue, workflow artifact, or log.

## Repository verification

- Run Gitleaks against the complete Git history with redaction enabled.
- Confirm every Gitleaks allowlist entry remains an exact synthetic fixture; do not allowlist a path,
  commit, detector rule, or generic credential pattern.
- Confirm the GitHub Actions `Git history secret scan` and `verify` jobs pass on the intended default
  branch and on a pull request.
- Confirm branch protection requires both jobs before merge. If the current GitHub plan does not
  offer protection for private repositories, configure it immediately after the explicitly
  authorized visibility change and before announcing or sharing the public repository.
- GitHub repository-level private vulnerability reporting is available only for public
  repositories. After the explicitly authorized visibility change, enable it and verify the
  **Report a vulnerability** form before announcing or sharing the public repository.
- Review the final release archive and confirm no private data, test fixture, temporary report,
  environment file, signing key, or credential is present.
- Confirm the author display name and noreply email in every commit are intentionally public and
  match the maintainer's chosen identity before pushing. Changing historical commits requires
  separate authorization.
- Have a non-author reviewer follow README installation and usage in a clean environment, including
  invalid input, repeat execution, and report write failure. Record tested operating systems.

The workflow checks out full history and runs a checksum-verified, pinned Gitleaks CLI directly.
It does not comment on pull requests or upload findings artifacts.

## Release materials

- `LICENSE` declares Apache-2.0 and is present in the archive.
- `SKILL.md` and `CHANGELOG.md` are present in the repository and release archive.
- `PRIVACY.md`, `SECURITY.md`, and `CONTRIBUTING.md` match the shipped behavior.
- The package installation smoke test completes the import–scan–export loop.
- Known limitations and unverified compatibility claims remain visible in `README.md`.

Creating the repository, committing, pushing, enabling branch protection, running GitHub-hosted CI,
and publishing are external actions and must be performed only with explicit authorization.

## Local evidence snapshot — 2026-09-20

This snapshot describes the current uncommitted working tree; it is not a public release approval.

- Gitleaks v8.30.1, obtained from the official release asset and verified against its published
  SHA-256 digest, scanned all local Git history (`--log-opts=--all`, one commit) and the current
  directory. Both scans reported no leaks. Repeating both with `--ignore-gitleaks-allow` also
  reported no leaks. Scans used `--redact`; detector coverage is not a guarantee that no secret
  exists.
- Repository policy, TypeScript typecheck, 48/48 regression tests, and the production build passed
  with Node.js 24.19.0. The private structural compatibility sample passed 22/22 items without
  printing its contents. Package dry-run and installed-package smoke test passed. The installed
  package smoke test also rejected malformed input, refused to overwrite an existing report on
  repeat execution, and rejected an unavailable output directory without leaving a partial report.
- The existing commit author name and repository-local author name are `Jean Zha`, the identity
  chosen by the maintainer. No Git history was changed.
- Still pending: a clean Codex installation's matching and non-matching Skill-trigger tests; an
  independent non-author installation and failure-path review; GitHub-hosted CI on the eventual
  repository and pull request; branch protection and private vulnerability reporting. Commit,
  push, and publication remain unauthorized in this verification pass.

## Local Codex trigger evidence — 2026-09-21

Real Codex CLI `0.155.0-alpha.2.6` with `gpt-5.6-sol` ran in an isolated temporary directory on
macOS. The working-tree Skill was linked at `.agents/skills/conversation-curator`; each session used
`--ephemeral --ignore-user-config --sandbox read-only --skip-git-repo-check`. The tested `SKILL.md`
SHA-256 was `3fcc691f798269f0dde166d2932d463a05a81943dc036d0219458165e6a6731b`. These checks
prove local Codex CLI discovery and behavior for this snapshot, not a fresh third-party installation
or desktop UI behavior. No private export was used.

- Explicit `$conversation-curator` request without an input path: Codex requested the local
  `conversations.json` path, did not search for files, and deferred import. The JSON trace did not
  expose a separate Skill-file read for explicit injection, so this is behavioral evidence only.
- Implicit matching request without a path: the trace showed Codex reading the target `SKILL.md`
  and `README.md`; it requested only the path and deferred import. The ordinary CLI PATH lacked
  `node`, which it correctly reported as a runtime prerequisite.
- Implicit matching request with a one-conversation synthetic export: after supplying the bundled
  Node.js `24.20.0` executable on PATH, the trace showed the target Skill read and the exact
  `src/cli.ts --input <synthetic-path> --summary-only` run. The command exited 0 with one total and
  one classified item, zero failures; Codex returned aggregate counts only. No `--write` command
  ran, and the temporary directory contained no report file.
- Negative controls: a request to rename/archive chats on the live ChatGPT website selected
  OpenAI Docs, not Conversation Curator; a paper-and-pencil general chat organization request and
  a Claude JSON export request selected no Conversation Curator Skill. All three traces had no
  target `SKILL.md` read or curator CLI execution.

The CLI transport repeatedly timed out on WebSockets before falling back to HTTPS. All six
sessions ultimately completed with exit code 0, but this was one run per prompt, not a reliability
sample. The temporary test directory, containing only the synthetic export and Skill symlink, was
removed after verification. An independent non-author clean installation and failure-path review,
GitHub-hosted CI, branch protection, and private vulnerability reporting remain blocked release
gates. No commit, push, or publication was performed.

## Independent non-author AI review — 2026-09-21

A separate AI reviewer with no authoring role independently read the current working tree and used
only synthetic data in a temporary installed-package consumer on macOS with Node.js 24.19.0. This
is an independent **AI** review, not a human third-party review or a different-OS test. The reviewer
made no tracked-file changes and did not open the private compatibility sample or real export.

- Typecheck, 48/48 regression tests, repository policy, package smoke, and package manifest check
  passed. The reviewer separately exercised successful import–scan–export, malformed input,
  repeated execution without overwriting the report, and report-write failure with temporary-file
  cleanup in the installed package.
- **P1 — credential prefilter gap:** `src/core/security-scanner.ts` declares several hard credential
  formats that its prefilters do not admit. Synthetic `sk_live_` / `rk_live_` values and
  `APIKEY` / `CLIENTSECRET` assignments were all reported as `S0` with `hard=false`, rather than
  `S3`. The prefilters and detector patterns must agree, with regression tests for every branch.
- **P1 — duplicate ID skips security scanning:** `src/core/pipeline.ts` counts and skips a repeated
  conversation reference before scanning its content. With two synthetic items sharing an ID and
  a password field only in the second item, the CLI exited 0 and reported total 2, classified 1,
  duplicate 1, failed 0, and S3 0. Unscanned duplicates must not be represented as a complete,
  successful security result.
- **P2 — Action pinning:** the external Actions in `.github/workflows/ci.yml` use version tags, not
  immutable commit SHAs. Pinning them would reduce supply-chain drift; no compromise was observed.

The maintainer's separate read-only cross-check found another **P1 release-gate weakness**:
`scripts/repository-policy-check.ts` skips any line containing `gitleaks:allow`, even when the
scanner itself would identify a hard match on that line. Gitleaks also treats this marker as an
inline suppression by default, while the CI workflow does not disable it. The line-targeted
allowlist regexes in `.gitleaks.toml` are unanchored, so they do not enforce their stated
"exact synthetic fixture" scope. This finding concerns future additions to the repository; it
does not contradict the previous scans finding no leak in the current tree. Tighten both checks
before relying on CI as a privacy gate.

**Conclusion:** the non-author AI review is complete but **failed** on its two P1 findings; the
separate maintainer cross-check adds one P1 release-gate weakness. Public release remains blocked.
This review does not replace a human third-party review if that is required, nor does it complete
GitHub-hosted CI, branch protection, or private vulnerability reporting. No commit, push, or
publication was performed.

## Local remediation evidence — 2026-09-21

The three P1 findings above were addressed in the uncommitted working tree. Declared credential
formats now have matching prefilters; synthetic counterexamples are S3 and redacted before
classification and output. Duplicate-ID items are scanned before classification is skipped; their
S3 counts are retained and any duplicate causes CLI exit code 2 instead of a complete-success code.
The repository policy now rejects any new or altered inline suppression in any tracked file type,
while a path-and-line digest manifest preserves only previously reviewed synthetic fixtures.
Historical Gitleaks allowlist expressions now match complete synthetic lines. The P2 CI Action
references were also pinned to full commits obtained from their official Git tags.

- Repository policy, TypeScript typecheck, 51/51 tests, production build, package dry-run and
  installed-package smoke test passed. The private structural compatibility check passed 22/22.
- Gitleaks v8.30.1 with `--ignore-gitleaks-allow` found no leaks in the one-commit Git history or
  current directory after the allowlist change. These scans do not prove that unknown secret
  formats cannot be missed.
- Three synthetic memory benchmarks passed below 256 MiB: 50,000 items at 128.1 MiB peak RSS,
  approximately 249.1 MiB input at 122.7 MiB, and 30 large items at 172.6 MiB.

This is a local repair and self-verification record, **not** a new non-author review. Public release
remains blocked pending independent re-review of the changed code, GitHub-hosted CI, branch
protection, and private vulnerability reporting. No commit, push, or publication was performed.

## Short credential follow-up — 2026-09-21

A subsequent local review found that one- to three-character values in named credential fields
could be classified as S0 and passed unchanged into classification context. A one-character
assignment could also pass the final output check. The `PASSWORD_FIELD` detector now covers
non-empty values of any length, including quoted values. A focused regression test failed before
the repair and passed afterward; the duplicate-ID end-to-end case now uses a short synthetic
credential to exercise both boundaries together.

- Repository policy, typecheck, 52/52 tests, production build, package dry-run, installed-package
  smoke test, and private structural compatibility check (22/22) passed locally.
- Three synthetic memory runs remained below 256 MiB peak RSS: 50,000 items at 120.1 MiB,
  approximately 249.1 MiB input at 122.2 MiB, and 30 large items at 178.2 MiB.
- Gitleaks was not available on this task's PATH, so current-tree and full-history Gitleaks scans
  were **not rerun after this follow-up change**. The earlier scans belong to the prior snapshot.

This follow-up is self-verification only. Public release remains blocked pending Gitleaks rerun on
the final tree, non-author re-review, GitHub-hosted CI, branch protection, and private vulnerability
reporting. No commit, push, or publication was performed.

## Incremental non-author review and Gitleaks policy repair — 2026-09-21

The original non-author AI reviewer revisited only the previously failing credential-prefilter and
duplicate-ID paths plus the later short-credential change. Synthetic probes confirmed that the
original two P1 findings and a one-character named credential are closed: the tested values are S3
and redacted, and a
duplicate-ID run retains the second item's S3 count while returning exit code 2. The reviewer did
not repeat the full suite, compatibility check, package smoke test, or memory benchmarks.

This incremental review found a new P1 in the repository policy: an extra unmarked expression in
`.gitleaks.toml` could broaden its allowlist without tripping the inline-marker gate. The complete
reviewed Gitleaks config is now SHA-256 pinned in `scripts/approved-gitleaks-config.ts`, and the
repository policy rejects any content change. A targeted regression covers an added match-all
line. The non-author reviewer independently confirmed the counterexample is rejected. Targeted
policy tests (2/2), the repository policy, TypeScript typecheck, and `git diff --check` passed.

This gate fails closed on line-ending changes, so Windows checkout behavior remains unverified.
An in-repository digest cannot stop a malicious change that also edits the approval code; review
and branch protection remain necessary. No new P0/P1 was found within this narrow re-review, but
it is not a complete final-version release review. Gitleaks itself could not be rerun in this
environment after the latest changes: no local binary was available, and two attempts to obtain
the official release asset failed at the network connection. GitHub-hosted CI, branch protection,
private vulnerability reporting, and public publication remain blocked. No commit, push, or Git
history rewrite was performed.

## Local Gitleaks rerun — 2026-09-21

The official Gitleaks v8.30.0 macOS arm64 archive matched its published SHA-256. With explicit
user approval, the macOS quarantine attribute was removed **only from a temporary extracted
copy** of the binary; the downloaded archive and system security settings were not changed.
Gitleaks then reported version 8.30.0.

The full local Git history (`--all`, one commit) and a separate snapshot of 43 tracked or
unignored publish-candidate files were scanned with the repository config,
`--ignore-gitleaks-allow`, and redaction enabled. Both scans reported no leaks. The private
compatibility sample and the original ChatGPT export were excluded from the snapshot and were
not read by this scan. Synthetic canaries confirmed detection of a generic API key and a
field-labeled GitHub token; two other illustrative token formats were not detected. Thus this
is a completed scanner run, **not** proof that every possible secret format is covered.

GitHub-hosted CI, branch protection, private vulnerability reporting, and a complete final-version
non-author review remain unverified. No commit, push, publication, or Git history rewrite was
performed.

## First private GitHub CI run — 2026-09-21

The private repository's first push at `4e1928b` passed `verify`, but `Git history secret scan`
failed before scanning: `gitleaks-action` v3 constructed an invalid initial-push revision range,
and its log reported approximately zero bytes scanned. Exit code 1 therefore indicates a scan
execution error here, not a secret finding or a successful clearance. The Ubuntu runner migration
notices were unrelated.

The workflow now downloads official Gitleaks v8.30.0 for Linux x64, checks the published SHA-256,
and runs `gitleaks git --log-opts=--all` with the reviewed config, inline allowances disabled, and
redaction enabled. This avoids action-generated push ranges and produces no PR comments or SARIF
artifacts. The revised hosted job has **not yet run**. Public release remains blocked until both
hosted jobs pass, branch protection and private vulnerability reporting are confirmed, and the
final version is reviewed. No secret value was present in the supplied failure screenshot.

The post-fix local full-history scan then found one test-only encrypted-private-key header in
`test/core.test.ts` from commit `4e1928b`; the line contains no key body or usable credential.
Because committed history must not be rewritten, `.gitleaksignore` excludes only this finding's
exact commit/file/rule/line fingerprint. The repository policy pins the entire ignore file and
rejects additions or edits. No path-wide, rule-wide, or generic key-format exception was added.
Gitleaks v8.30.0 then scanned all three local commits and the tracked-file snapshot separately:
both reported zero findings. Type-check, 54 tests, build, and repository policy passed. The
hosted rerun for commit `54b4115` completed successfully in GitHub Actions run `35535229043`.
The green overall result confirms both jobs in the fixed two-job workflow passed; the red run for
`4e1928b` is the superseded first run described above.

The original non-author AI reviewer then performed an incremental review limited to commits
`4d30cd6` and `54b4115`. It found no new P0, P1, or P2 issue in the checksum-pinned Gitleaks
installation, full-history invocation, exact fingerprint exception, policy guard, regression
test, or release record. This was not a repeat review of the previously accepted classifier and
privacy implementation. Public release remains blocked until branch protection and private
vulnerability reporting are confirmed; this evidence does not make the private repository public.

## Public repository release gates — 2026-09-21

The repository was made public only after explicit maintainer authorization. GitHub-hosted CI
passed on `main` at `192d2ee`, on pull request #1 at `62d4ce0`, and again on `main` after that
commit was fast-forwarded. Both `Git history secret scan` and `verify` passed in each current run;
the failed initial run at `4e1928b` remains visible as superseded historical evidence.

GitHub private vulnerability reporting is enabled. The active `Protect main` ruleset targets the
default branch with no bypass actors, restricts deletion, requires pull requests with zero
approvals, requires branches to be current, requires the GitHub Actions checks `Git history secret
scan` and `verify`, and blocks force pushes. Direct updates, signed commits, deployments, code
scanning, and preview-only Copilot approval rules are not required.

The public repository gates are complete with documented boundaries: the independent reviewer was
an AI reviewer rather than a human third party, the local compatibility and memory evidence is from
macOS, and GitHub-hosted verification is from Ubuntu. This is approval for the source repository's
public availability, not a claim of universal platform compatibility, zero privacy risk, or a
versioned package-registry release.
