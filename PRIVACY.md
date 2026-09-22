# Privacy

Conversation Curator is designed to process ChatGPT exports locally. The current CLI does not include network or telemetry code and does not modify the source platform.

When used through the Codex Skill, the Skill prints a command for the user to run in their own terminal. If the user pastes back the `--summary-only` result, only aggregate counts become part of the Codex conversation. The Skill does not ask for the real export path and does not open the original export or detailed report into the model conversation.

## Threat model

The CLI is designed to reduce accidental disclosure through its own cooperative workflow: it does not place message content in terminal summaries or reports, upload data, or modify the source platform. It does not sandbox the source file from an agent or process that already has local filesystem permission. For that threat, run the CLI yourself and share only aggregate output; eliminating the capability requires OS-level permission separation or an isolated environment.

## Data read

- The user-selected `conversations.json` file is opened read-only.
- The CLI opens the selected path once and copies from that file handle into a mode-`0600` temporary snapshot. The 256 MiB limit is enforced both before and during capture. Structure validation, hashing, and parsing all use the same captured bytes, and the snapshot is removed at the end of the run.
- The first non-empty array element in the snapshot must have a stable ChatGPT conversation ID and a `mapping` object.
- A conversation may contain at most 50,000 `mapping` nodes. Larger mappings fail before all-node fallback expansion and sorting.
- Deterministic sensitive-data scanning covers the title, every textual message on the selected branch, and an allowlist of attachment metadata fields such as filename and content type.
- Classification uses only the title plus at most the first three and last three textual messages on that branch, after both sensitive-pattern and output-privacy redaction (including email, phone number, and local path rules).
- A title or sampled message longer than 32 Ki characters is reduced to bounded leading and trailing context for classification and is always marked for review; deterministic scanning still inspects the complete text.
- Attachment bodies, binary data, images, audio, and non-allowlisted attachment fields are not added to scanning or classification text.
- When the current branch cannot be resolved, the adapter marks the all-message fallback for mandatory review.
- Direct CLI execution uses a local child process with fixed V8 heap bounds (`--max-old-space-size=96` and `--max-semi-space-size=2`).

## Data written

The CLI writes a report only when the user supplies both `--write` and `--output`.

The report is a streamed JSON event array containing:

- a fixed format name, source byte count, and grouped SHA-256 digest (not the original filename, path, or filesystem modification time);
- deterministic one-way local conversation references instead of source conversation IDs;
- message counts, risk types and counts, and classification fields;
- safe failure codes and messages;
- aggregate counts and final privacy assertions.

It does not intentionally contain message bodies, original titles, source conversation IDs, or matched sensitive values. Every outgoing string is scanned and sanitized, and the completed output path is committed only after all events pass the final output scan.

The grouped source hash and conversation references are deterministic. They do not reveal the raw
identifier by themselves, but they allow someone holding multiple reports to test whether the same
source file or conversation appears again. Successful reports therefore declare
`privacy.crossRunLinkable: true`. Randomizing these values would remove that linkage but would also
remove the current reproducibility and duplicate-comparison property; this version preserves the
property and discloses it. Treat reports as private data.

In a successful report, `privacy.sensitiveValuesIncluded` is always `false`. If the output boundary detects a sensitive value, the run fails before emitting the summary or committing the report rather than producing a report with that field set to `true`.
The original input filename and the selected output path are not written to the report or terminal output.

## Storage, deletion, and recovery

- Reports are stored only at the path selected by the user.
- Reports are private derived data. Inside this repository, store them only under the Git-ignored
  `.private-reports/` directory and never commit them.
- Temporary input snapshots and report files use restrictive permissions. Failure or cancellation triggers cleanup. Snapshot cleanup failure returns `INPUT_SNAPSHOT_CLEANUP_FAILED`; report cleanup failure returns `OUTPUT_CLEANUP_FAILED`. Both require the user to remove the named temporary artifact class without echoing a private source path.
- Delete the report file to remove the persisted result.
- There is no database, cloud backup, cross-device sync, or recovery service in this version.
- Deleting the only copy is irreversible.

## Private compatibility sample

An authorized, de-identified export used for local compatibility testing belongs only at
`.private-test-data/conversations.json`. The directory is ignored by Git and excluded from the
release package. The compatibility command reads the file locally without writing a report and
prints only aggregate counts; it does not print the path, conversation metadata, or classification
details. Removing the file deletes the project's only managed copy.

## Limits

Sensitive scanning is rule-based and cannot guarantee zero missed data. Do not publish reports without reviewing them. A locally held, de-identified structural copy of one real ChatGPT export passed compatibility checking (22/22 classified); this does not establish compatibility with every export version or content shape.
