# Privacy

Conversation Curator is designed to process ChatGPT exports locally. The current CLI does not include network or telemetry code and does not modify the source platform.

When used through the Codex Skill, the `--summary-only` CLI result contains aggregate counts. These counts become part of the Codex conversation. The Skill does not open the original export or detailed report into the model conversation.

## Data read

- The user-selected `conversations.json` file is opened read-only.
- Deterministic sensitive-data scanning covers the title, every textual message on the selected branch, and an allowlist of attachment metadata fields such as filename and content type.
- Classification uses only the title plus at most the first three and last three textual messages on that branch, after both sensitive-pattern and output-privacy redaction (including email, phone number, and local path rules).
- A title or sampled message longer than 32 Ki characters is reduced to bounded leading and trailing context for classification and is always marked for review; deterministic scanning still inspects the complete text.
- Attachment bodies, binary data, images, audio, and non-allowlisted attachment fields are not added to scanning or classification text.
- When the current branch cannot be resolved, the adapter marks the all-message fallback for mandatory review.

## Data written

The CLI writes a report only when the user supplies both `--write` and `--output`.

The report is a streamed JSON event array containing:

- a fixed format name, source byte count, and grouped SHA-256 digest (not the original filename, path, or filesystem modification time);
- one-way local conversation references instead of source conversation IDs;
- message counts, risk types and counts, and classification fields;
- safe failure codes and messages;
- aggregate counts and final privacy assertions.

It does not intentionally contain message bodies, original titles, source conversation IDs, or matched sensitive values. Every outgoing string is scanned and sanitized, and the completed output path is committed only after all events pass the final output scan.
The original input filename and the selected output path are not written to the report or terminal output.

## Storage, deletion, and recovery

- Reports are stored only at the path selected by the user.
- Reports are private derived data. Inside this repository, store them only under the Git-ignored
  `.private-reports/` directory and never commit them.
- Temporary report files use restrictive permissions. Failure or cancellation triggers cleanup; if cleanup itself fails, the CLI returns `OUTPUT_CLEANUP_FAILED` and instructs the user to remove the hidden `.tmp` file.
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
