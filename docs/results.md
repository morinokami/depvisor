# Reading depvisor's results

A depvisor run serves exactly one updater PR and ends in exactly one status.
Statuses are a fixed, kebab-case vocabulary: they appear in the run annotation,
the step summary, and the `status` action output, and they never carry free
text. A red status fails the job — silent no-repair outcomes are a bug class
this design refuses.

## Green statuses (the job passes)

| Status             | Meaning                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report-prepared`  | Verification passes on the PR as-is; the reviewer report comment was prepared and published. No repair was needed.                                                                                                           |
| `repair-prepared`  | The PR broke verification, the merge base verified green, and a bounded source repair was committed, re-verified, and pushed to the PR's head branch, together with the report comment.                                      |
| `not-an-update-pr` | The PR is not a pure dependency-update PR: a commit touches non-dependency paths (a human owns work on the branch), the PR changes no dependency depvisor can name, or it adds no commits beyond the base. Nothing was done. |
| `deferred`         | Verification fails and the fixer judged the repair unsafe to make here (e.g. it would need a manifest change, which depvisor never makes). No repair was pushed; the report comment explains the blocker. Needs a human.     |
| `publish-blocked`  | The analysis finished, but the PR was merged/closed mid-run or its head moved (the updater rebased, or someone pushed). Nothing was pushed or commented; the next PR event re-runs on the new head.                          |

`deferred` and `publish-blocked` are green on purpose: the fixer declining an
unsafe repair and the updater churning its branch are designed-for situations,
not failures. The report comment (for `deferred`) and the next trigger (for
`publish-blocked`) carry the follow-up.

## Red statuses (the job fails)

Configuration (reported before the target repository is touched):

| Status          | Meaning                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `bad-base-ref`  | The `base_ref` input is missing or not a usable branch name. Run on `pull_request` events. |
| `bad-head-ref`  | The `head_ref` input is not a usable branch name (or the checkout is a detached HEAD).     |
| `bad-pr-number` | The `pr_number` input is not a positive integer.                                           |
| `bad-language`  | The `language` input is not a BCP-47-style tag like `ja` or `pt-BR`.                       |

Preflight (the starting point is unusable):

| Status                        | Meaning                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not-a-repo-root`             | The target path is not the root of its own git repository.                                                                                                                           |
| `persisted-credentials`       | The checkout carries credentials (actions/checkout defaults to `persist-credentials: true`). Set it to `false`.                                                                      |
| `dirty-tree`                  | The checkout has uncommitted changes; depvisor refuses to analyze or repair on top of them.                                                                                          |
| `unsupported-package-manager` | The repo uses a package manager depvisor does not support (currently npm, pnpm, bun; yarn is not supported).                                                                         |
| `ambiguous-package-manager`   | Multiple PMs' lockfiles and no `packageManager` field to disambiguate.                                                                                                               |
| `missing-base-ref`            | The base branch was not fetched into the checkout, or no merge base exists. Check out with `fetch-depth: 0`.                                                                         |
| `no-verify-scripts`           | package.json defines none of `build`/`lint`/`test` and `verify_commands` is unset — the verification gate cannot vouch for anything, so nothing is analyzed or published, by design. |

Analysis and repair:

| Status                  | Meaning                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline-red`          | The PR head fails verification, but so does its merge base — the failure cannot be attributed to the update, so no repair is attempted (fail-closed). Fix the base branch first.         |
| `reinstall-unavailable` | Attribution needs a baseline reinstall, but `install_command` is `skip` and the repo tracks no lockfile, so no reinstall command exists. Commit a lockfile or set `install_command`.     |
| `reinstall-failed`      | Installing the merge base's (or head's) dependencies failed mid-attribution.                                                                                                             |
| `verification-failed`   | The fixer attempted a repair but the checks still fail; the attempt was discarded (never committed or pushed) and the report comment explains what is broken. This update needs a human. |
| `scope-violation`       | Changes appeared outside the allowed source/test scope — from the fixer or from a target script — and were rejected; nothing was committed or published.                                 |
| `unexpected-commits`    | A target install/verification script moved git refs or HEAD. Everything was restored to the last trusted state; nothing was published.                                                   |
| `no-structured-result`  | The fixer did not return a parseable structured result. Usually transient; if it recurs, consider a stronger `llm_model`.                                                                |
| `in-progress`           | The crash marker: the run died before finishing. The job fails so the interruption is visible.                                                                                           |

Publishing (the token-holding step):

| Status           | Meaning                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `publish-failed` | Pushing the repair or posting/updating the report comment failed for a real reason (auth, API, tampering guard). |

## Action outputs

All outputs are machine-shaped (fixed-vocabulary statuses, `"true"`/`"false"`,
charset-gated URLs, plain numbers) so consumer workflows can branch on them
without a workflow-command/shell-injection surface. A red run fails the job,
so consuming steps need `if: always()`.

| Output         | Value                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `status`       | The run status above; empty when the run crashed before writing a status file.                          |
| `failed`       | `"true"` when this run fails the job, else `"false"`.                                                   |
| `repaired`     | `"true"` when a verified repair commit was created this run.                                            |
| `comment_url`  | URL of the report comment, when one was created or updated.                                             |
| `total_tokens` | Total LLM tokens across the fixer and digest operations; `"0"` when none ran.                           |
| `est_cost_usd` | Provider-priced cost estimate (not an invoice); `"0.000000"` when no agent ran, empty when unavailable. |

Consume them env-mediated, never inline in `run:` scripts:

```yaml
- name: Notify on repair
  if: always() && steps.depvisor.outputs.repaired == 'true'
  env:
    COMMENT_URL: ${{ steps.depvisor.outputs.comment_url }}
  run: echo "depvisor repaired this PR — report: $COMMENT_URL"
```

Known runner bug: nesting the depvisor action inside another composite action
loses step outputs (actions/runner#2009) — consume these from a workflow step
directly.

## Where the detail lives

- The **step summary** (Actions UI) shows the status, the dependency-change
  table, verification results, any test files the repair touched, and LLM
  token/cost usage with the model name.
- The **report comment** on the PR carries the reviewer-facing narrative: the
  deterministic verdict line, the package table with source links, what the
  upstream changes mean for this repository, breaking changes addressed, risks
  and review notes, a ⚠️ section when the repair modified test files, and the
  verification checklist. The narrative sections are LLM-written and
  sanitized; everything else is deterministic.
- The **repair commit** (`fix: adapt code to <packages> update`) is committed
  by `depvisor[bot]` and bounded to source and tests — dependency state is
  never touched.
