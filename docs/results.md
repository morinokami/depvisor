# Results

One run describes one immutable PR head. The reusable workflow outputs:

- `status`: terminal status below;
- `pr`: resolved PR number, empty for `no-target`; and
- `repair_applied`: `true` when a verified depvisor repair was pushed or a green
  rerun recognized an existing repair.

The publisher also upserts one `<!-- depvisor:v2 -->` PR comment, creates a
`depvisor` Check, and uploads a schema-validated `result.json` containing the
base/PR/updater/published SHAs, provider, normalized changes, verification,
report URL, repair flag, and per-role usage. Candidate verification records the
approved patch SHA-256; the publisher requires it to match before writing. Test
paths changed by the fixer are listed explicitly in the report.

## Neutral

| Status                      | Meaning                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `no-target`                 | The workflow run did not resolve to exactly one open PR.                |
| `not-updater`               | The PR is an ordinary human/non-updater PR.                             |
| `policy-skipped`            | Trusted policy selected neither review nor repair.                      |
| `updater-refresh-requested` | The publisher successfully asked the updater to regenerate.             |
| `stale-base`                | Base moved before publication; nothing was pushed.                      |
| `stale-head`                | Head moved before publication; nothing was pushed.                      |
| `human-takeover`            | A positively identified human commit owns the branch; depvisor yielded. |

## Green

| Status              | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `reviewed`          | Report policy selected the PR and repair policy did not.                         |
| `repair-not-needed` | Provider-only head CI was green; no fixer ran.                                   |
| `repair-applied`    | One verified repair was pushed, or its subsequent green CI rerun was recognized. |

## Red

| Status                     | Meaning                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `unsupported-provider`     | No safe provider adapter can interpret the automation.            |
| `untrusted-updater`        | A claimed supported provider failed actor/commit attestation.     |
| `bad-config`               | Base-tip configuration is absent, malformed, or unsupported.      |
| `verification-unavailable` | Selected repair has no authoritative local commands.              |
| `repair-unsupported`       | At least one selected change is below `repair-safe`.              |
| `updater-refresh-required` | Regeneration is required but has no configured automatic handoff. |
| `baseline-red`             | Current base-tip commands fail or author working-tree changes.    |
| `verification-unstable`    | Clean confirmation attempts disagree.                             |
| `failure-not-reproduced`   | Trigger CI was red but local head verification is green.          |
| `repair-deferred`          | The one-shot fixer declined or returned no usable repair.         |
| `verification-failed`      | The one-shot candidate did not pass the full command set.         |
| `scope-violation`          | Candidate/verifier crossed the source/test-only boundary.         |
| `unexpected-commits`       | Target execution or attribution moved refs/commits unexpectedly.  |
| `publish-failed`           | A current verified result could not be safely pushed/reported.    |

`in-progress` is an internal crash marker, never a successful terminal result.
Red statuses fail the called workflow. Neutral statuses safely decline mutation.
