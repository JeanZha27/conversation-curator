# Privacy

Conversation Curator is designed to process ChatGPT exports locally. The current CLI does not include network or telemetry code and does not modify the source platform.

## Data read

- The user-selected `conversations.json` file is opened read-only.
- Classification uses the title plus at most the first three and last three valid messages on the selected branch.
- Non-text attachment parts are ignored.
- Deterministic sensitive-data scanning runs before classification.

## Data written

The CLI writes a report only when the user supplies both `--write` and `--output`.

The report is a streamed JSON event array containing:

- sanitized source metadata and a grouped SHA-256 digest;
- one-way local conversation references instead of source conversation IDs;
- message counts, risk types and counts, and classification fields;
- safe failure codes and messages;
- aggregate counts and final privacy assertions.

It does not intentionally contain message bodies, original titles, source conversation IDs, or matched sensitive values. Every outgoing string is scanned and sanitized, and the completed output path is committed only after all events pass the final output scan.

## Storage, deletion, and recovery

- Reports are stored only at the path selected by the user.
- Temporary report files use restrictive permissions and are removed after failure or cancellation.
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

Sensitive scanning is rule-based and cannot guarantee zero missed data. Do not publish reports without reviewing them. Real ChatGPT export compatibility remains unverified until an authorized, locally stored, de-identified sample is tested.
