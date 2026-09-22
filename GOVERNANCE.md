# Governance

## Current status

Conversation Curator is a pre-1.0, single-maintainer project. `JeanZha27` is the current maintainer
and final decision maker. A pull request, automated check, or AI-assisted review is not independent
human approval unless a non-author human reviewer records that approval on GitHub.

The repository is suitable for personal use and controlled evaluation. Public source availability
does not make it an enterprise-supported dependency or establish classification accuracy, complete
sensitive-data detection, or compatibility with every ChatGPT export version.

## Decisions and review provenance

- User-visible behavior, privacy boundaries, report fields, file access, dependencies, and CI policy
  must change through a pull request with passing required checks.
- Every pull request must state whether non-author human review was obtained. If it was not, the pull
  request must say so rather than treating automated or AI-assisted analysis as independent review.
- Security-sensitive evidence must use private vulnerability reporting. Real exports, reports,
  credentials, personal data, and unredacted logs must not be posted in issues or pull requests.
- The maintainer may reject a change that weakens privacy boundaries, deterministic failure
  behavior, reproducibility, or the documented offline scope.

## Versioning and releases

- Versions follow Semantic Versioning. Before `1.0.0`, minor releases may change unsupported or
  experimental behavior; every breaking report-schema change must still be called out explicitly.
- A release is blocked unless every required item in `docs/release-checklist.md` passes.
- A release tag must be an annotated, cryptographically signed `vMAJOR.MINOR.PATCH` tag created by
  the maintainer. The corresponding GitHub Release must point to that exact tag and link the passing
  `main` CI run. Unsigned tags and untagged source snapshots are not project releases.
- `package.json` remains `private: true` until package-registry publication is intentionally approved,
  documented, and tested. A GitHub source release does not imply an npm release.
- Until the first signed release exists, only the latest commit on `main` is supported and no stable
  API or long-term support promise is made.

## Adding maintainers

Additional maintainers are added only through a public governance change after sustained,
security-conscious contributions and demonstrated ability to review privacy-sensitive changes. The
repository must not claim a second maintainer or independent review before that person has accepted
the role and has appropriate repository access.

Governance changes use the same pull-request and CI requirements as code changes.
