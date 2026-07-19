# Results

One depvisor run corresponds to one existing updater PR. The action writes a
step summary, maintains one PR comment, and exposes machine-readable outputs.
Backticked file mentions in the comment link to the file at the exact commit
the report describes — the repair commit when one was pushed, otherwise the
reviewed PR head — and only when the file actually exists there; the publisher
builds these links itself and never renders an agent-authored URL. The comment
footer carries a "workflow run" link to the workflow run that last wrote the
comment, so reviewers can jump straight to that run's logs.

For a no-repair review the comment also carries a machine-readable state line
naming the reviewed head, its CI conclusion, and the depvisor version. A later
run for the same head with the same green conclusion reuses it to skip a
duplicate model review (`already-reviewed`). The comment is editable, so the
line is trusted only for that: a forged or deleted line at worst skips or
re-runs one informational review, and a non-success CI conclusion always gets
a full run.

## Outputs

| Output         | Meaning                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `status`       | Final status below, or empty if setup crashed before a record was written.       |
| `failed`       | `true` when the job must fail. Safe to consume from a later `if: always()` step. |
| `repaired`     | `true` only when a repair commit was pushed.                                     |
| `pr_url`       | Target updater PR URL.                                                           |
| `commit_sha`   | Repair commit SHA, empty when no commit was needed.                              |
| `comment_url`  | Maintained reviewer-report comment URL.                                          |
| `total_tokens` | Model tokens used by the agent, empty when no agent result exists.               |
| `est_cost_usd` | Provider-priced estimate, not an invoice. Empty when no agent result exists.     |

## Green statuses

| Status             | Meaning                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewed`         | The PR needed no code repair; depvisor posted/updated the reviewer report.                                                                                                                                                 |
| `already-reviewed` | The report comment already covers this exact head on a green CI run under the same depvisor version; the duplicate review was skipped.                                                                                     |
| `repair-published` | One repair commit was pushed to the existing updater branch and the report was posted. With the default token, the new head's CI run can need manual approval and does not restart depvisor by itself (see configuration). |
| `deferred`         | The agent identified a concrete blocker and reported it without publishing its working-tree edits.                                                                                                                         |
| `unsupported-pr`   | The triggering run did not belong to an open, same-repository Dependabot/Renovate PR, so it was ignored.                                                                                                                   |
| `stale-pr`         | The PR closed or its head moved while depvisor was working. The superseded run published nothing and completed without an error.                                                                                           |

## Failing statuses

| Status                     | Meaning                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `setup-failed`             | Runtime installation or PR-context preparation failed before agent work.                                                         |
| `wrong-head`               | The checkout was not the current updater PR head. Usually the workflow omitted `ref: ${{ github.event.workflow_run.head_sha }}`. |
| `agent-failed`             | The checkout was dirty, the model operation failed, or no valid structured result was produced.                                  |
| `dependency-state-changed` | The agent changed updater-owned dependency state or Git history. Nothing was published.                                          |
| `publish-failed`           | The fresh-clone commit/push or PR comment update failed. The summary carries the concrete error.                                 |
| `in-progress`              | The process stopped before reaching a final status. It fails closed.                                                             |

`deferred` is green because it is a complete, reviewer-visible outcome rather
than an infrastructure failure. `stale-pr` is green because a newer updater or
human head superseded the run and force-with-lease prevented an overwrite. Your
repository's required CI remains the merge gate; a green depvisor job does not
make a failing dependency PR mergeable.
