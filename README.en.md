# Conversation Curator

[简体中文](README.md) | [English](README.en.md)

Conversation Curator is a privacy-first local CLI and Codex Skill for reviewing a ChatGPT `conversations.json` export. It scans for sensitive data, groups conversations with deterministic heuristics, previews the result in the terminal, and can write a JSON report that excludes message bodies.

It does not connect to ChatGPT, call a remote model, send telemetry, or modify conversations on the source platform.

## Overview

Think of it as a **ChatGPT conversation organizer that runs only on your computer**. Give it the `conversations.json` file from an official ChatGPT data export. It groups conversations by topic and status, flags items that may contain sensitive data or need a human decision, and shows you a summary first.

By default, it saves no report. Each run creates a restricted temporary copy of the raw export and cleans it up afterward. It does not sign in to your ChatGPT account, upload chat content, or rename, archive, or delete conversations. It saves a local JSON report without message bodies only when you explicitly choose an output path.

The simplest way to use it:

1. Export your ChatGPT data, unzip it, and locate `conversations.json`.
2. In Codex, ask only for the local command and do not provide the real path:

   ```text
   $conversation-curator show me the safe local command; do not read the file.
   ```

3. Replace `<path>` and run the command in your own terminal. Paste back only the aggregate counts. If you need item-level suggestions, choose and inspect the report path locally.

Use it to understand the shape of a large chat history, find items that need manual review, and check for obvious sensitive-data risks before organizing. It is not a cloud-sync tool and cannot directly manage conversations on ChatGPT.

## How it works

```text
ChatGPT export (read-only)
  -> incremental parsing
  -> current-branch normalization
  -> local sensitive-data scan
  -> local heuristic classification
  -> terminal preview
  -> optional JSON report
```

## Use it as a Codex Skill

The root [SKILL.md](SKILL.md) is the Skill entry point. With Node.js 24 installed, place the complete repository in your Codex user Skill directory, for example `~/.agents/skills/conversation-curator/` on macOS or Linux. Keep `SKILL.md` and `src/cli.ts` together. Restart Codex if the Skill does not appear.

To avoid giving an agent the export path and read access, the Skill prints a command with a literal `<path>` placeholder instead of running the CLI. Replace the path and run it in your own terminal, then paste back only the aggregate `--summary-only` counts if you want help interpreting them. Keep detailed reports local. The Skill cannot rename, move, archive, or delete conversations on ChatGPT.

## Requirements

- Node.js 24 or later
- pnpm 11 for contributor checks

The CLI has no third-party runtime dependencies. Local execution has been verified on macOS. GitHub-hosted `verify` and `Git history secret scan` jobs pass on Linux. Windows has not yet been verified.

## Usage

These examples use the source checkout. An installed package uses `conversation-curator` (or `node dist/cli.js` in the package directory) with the same arguments, for example `conversation-curator --input <path> --summary-only`.

Preview without saving a report:

```bash
node src/cli.ts --input /path/to/conversations.json
```

Show aggregate counts only, which are suitable for pasting back to Codex:

```bash
node src/cli.ts --input /path/to/conversations.json --summary-only
```

Write a report after explicit confirmation:

```bash
node src/cli.ts \
  --input /path/to/conversations.json \
  --write \
  --output .private-reports/conversation-report.json
```

An existing output file is replaced only when `--force` is also provided. When writing inside this repository, use `.private-reports/`; the directory is ignored by Git.

The report is a streamed JSON event array:

```text
header -> conversation / failure (one per item) -> summary
```

The current `schemaVersion` is `1.4`. Its privacy metadata includes `crossRunLinkable: true` to make the deterministic source hash and conversation-reference linkage explicit. Consumers should parse by version and accept additional fields within the same major version.

The input must be a `.json` top-level object array whose first non-empty element contains a stable ChatGPT conversation ID and `mapping`. The CLI opens the source path once, enforces the 256 MiB limit while copying the captured bytes into a mode-`0600` temporary snapshot, and uses that snapshot for structure validation, hashing, and complete parsing. Unsupported structure returns `INPUT_NOT_CHATGPT_EXPORT`. Exit 0 means success; exit 2 means an empty or partial result; validation and runtime errors return 1; cancellation returns 130.

## Privacy model

- The selected export is opened read-only once. Later processing uses a bounded temporary snapshot, so replacing the source path cannot switch the run to another file. The snapshot is removed when the run ends, and cleanup failure is reported.
- Sensitive-data scanning covers the title, all text on the selected conversation branch, and allowlisted attachment metadata.
- Classification receives only the title and a redacted sample of the first three and last three textual messages.
- Direct CLI execution starts a local child process with fixed V8 heap bounds (`--max-old-space-size=96` and `--max-semi-space-size=2`).
- Attachment bodies, binary data, images, and audio are excluded.
- Source conversation IDs become one-way local references.
- Reports contain statistics, classifications, hashes, and safe failure fields, but no message bodies, original titles, source IDs, or matched sensitive values. Source hashes and conversation references are deterministic: someone holding two reports can tell whether they use the same source file or contain the same conversation. `privacy.crossRunLinkable` is always `true`, and reports should still be treated as private data.
- Every outgoing string is scanned again before the report is committed atomically.
- If the final output scan detects sensitive data, the run fails and does not commit the report.
- There is no database, cloud backup, telemetry, or cross-device synchronization.
- Threat model: the CLI reduces accidental disclosure through cooperative use, such as writing raw content to a report, repository, or remote model. It does not isolate the export from an agent or process that already has local filesystem access. The default boundary is human-run relay: run the CLI yourself and share only aggregate output. Stronger protection requires OS-level permission separation or an isolated environment.

Rule-based scanning cannot guarantee that every sensitive value will be detected. Treat generated reports as private data and review them before sharing.

## Limits

- Maximum input size: 256 MiB
- Maximum conversations: 50,000
- Maximum size of one conversation object: 8 MiB
- Maximum JSON nesting per item: 64 levels; lexical complexity: 250,000 units (container starts, strings, scalars, colons and commas). Exceeding either returns `INPUT_STRUCTURE_TOO_COMPLEX` before full parsing. Byte, structure and mapping limits apply independently; the first exceeded limit wins.
- Maximum `mapping` nodes per conversation: 50,000; larger mappings fail before expansion or sorting
- Classification context per long text: bounded leading and trailing segments from a 32 Ki character budget

Recent local synthetic benchmarks:

- 50,000 items: 15,316,673-byte input, 50,950,678-byte output, 128.8 MiB worker peak RSS
- Near-limit input: 4,000 items, 261,212,673-byte input (about 249.1 MiB), 4,148,678-byte output, 130.2 MiB worker peak RSS
- Large items: 30 items, 225,008,913-byte input (about 7.15 MiB message bodies), 31,778-byte output, 183.0 MiB worker peak RSS
- Mapping-node boundary: one 788,950-byte item with 50,001 empty nodes failed as expected with `MAPPING_NODE_LIMIT_EXCEEDED`, at 131.3 MiB worker peak RSS

Synthetic benchmarks for these input shapes stayed below the project's 256 MiB worker RSS threshold. They measure the processing worker directly and exclude CLI supervisor memory. These measurements do not guarantee the same memory profile for every real export.

The CLI supervisor owns this run's snapshot directory and registers temporary reports before creation. It cleans them after abnormal worker exit and replaces native diagnostics with `CLI_WORKER_FAILED`. If the supervisor itself is forcibly terminated, power is lost, or cleanup permissions fail, raw temporary data may remain. Treat `conversation-curator-run-*` directories in the system temporary location and hidden `.tmp` report files as private data.

Multipart messages are scanned both separately and concatenated. Each rule retains the larger per-message count across these views, then adds counts across messages; this is not a deduplicated count of distinct secrets. Negated or conflicting completion cues produce a low-confidence active status requiring review.

## Development

```bash
pnpm install --frozen-lockfile
pnpm policy:repository
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark:memory -- --items 50000 --max-rss-mib 256
pnpm benchmark:input-limit
pnpm benchmark:large-items
pnpm benchmark:mapping-nodes
pnpm pack:check
pnpm package:smoke
```

Tests use synthetic input only. A private, de-identified compatibility sample can be checked locally by saving it as `.private-test-data/conversations.json` and running:

```bash
pnpm compatibility:private
```

That directory is ignored by Git and excluded from the package. The check prints aggregate counts only and writes no report.

## Documentation

- [Privacy](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Changelog](CHANGELOG.md)
- [Implementation specification](docs/implementation-spec.md)
- [Release checklist](docs/release-checklist.md)

Conversation Curator is licensed under the [Apache License 2.0](LICENSE).
