# Reading depvisor's results

This page documents everything depvisor reports back: the job summary and
annotations, the composite action's outputs, the labels and warning sections on
the PRs it opens, and the full [status reference](#status-reference).

## The job summary and annotations

depvisor writes a job summary and an annotation for every known outcome, at both
the run level and per group. Benign outcomes stay green and explain why no PR
was opened; outcomes that need attention fail the job so they are not missed in
scheduled runs — a run stays red if any of its groups failed. Updates the
`minimum_release_age` cooldown clamped or held back are normal operation: they
stay green and are listed in the run summary. The
[status reference](#status-reference) below maps every status to its meaning and
fix.

The step summary has a section per group depvisor touched, each with its branch,
package version table, verification results, and the PR URL when one was created
or refreshed. Baseline and post-update verification output is grouped in the log
so repeated test output is easier to scan.

Each group that ran the agent also reports its LLM token usage and an estimated
cost (with the model name), and the run header shows the total across all groups
— handy under BYOK, where you pay per run, and when raising `open_pull_requests_limit`, since cost
scales with the number of groups. The cost is a provider-priced estimate (shown
`est. ~$…`), not an invoice; groups that opened no agent session (skipped,
held back, or dropped before the agent) contribute nothing.

## Action outputs

The action exposes the run's result to the following steps of your workflow, so
you can branch and notify on it — message a channel when a PR was opened, skip
a follow-up job when nothing was prepared. PR labels serve the same purpose on
the PR side (automation _after_ a PR exists); outputs are the in-workflow
counterpart. All values are deliberately machine-shaped — fixed-vocabulary
statuses, numbers, and strictly validated URLs, never the agent's free text —
so they are safe to consume:

| Output           | Value                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`         | Run-level status (`completed`, `no-updates`, or a red status — see the [status reference](#status-reference)). Empty when the run crashed before reporting |
| `failed`         | `"true"` / `"false"` — whether the run fails the job. A `completed` run with one failed group is `"true"`, and so is a crash that never wrote a status     |
| `prepared_count` | Number of dependency groups whose PR this run prepared (newly opened and refreshed alike)                                                                  |
| `pr_urls`        | Newline-separated URLs of the PRs this run opened or refreshed                                                                                             |

A red run fails the job, so steps that read the outputs need `if: always()` (or
`!cancelled()`). Take values into `run:` scripts through `env:` rather than
interpolating `${{ }}` directly — these outputs are validated, but the env
indirection is the habit that keeps a workflow injection-safe as it grows:

```yaml
- id: depvisor
  uses: morinokami/depvisor@v1
  with:
    llm_api_key: ${{ secrets.LLM_API_KEY }}
    llm_model: openai/gpt-5.5

- name: Notify about new depvisor PRs
  if: always() && steps.depvisor.outputs.prepared_count != '0'
  env:
    PR_URLS: ${{ steps.depvisor.outputs.pr_urls }}
  run: ./scripts/notify.sh "$PR_URLS"
```

One caveat: a known GitHub runner bug
([actions/runner#2009](https://github.com/actions/runner/issues/2009)) loses
step outputs when a composite action is nested inside _another_ composite
action — consume these outputs from workflow steps directly.

## PR labels

Every PR depvisor opens is labeled so you can build automation on top of it —
auto-merge rulesets, merge queues, notification filters, dashboards. depvisor
never merges anything itself (the final decision stays with you); it just hands
you structured signal. The labels are derived deterministically from the same
data the PR body shows:

- `depvisor` — on every PR, to select depvisor's PRs as a set.
- `semver:patch` / `semver:minor` / `semver:major` — the update's semver level.
- `security` — the update resolves at least one known advisory (see
  [Security prioritization](./configuration.md#security-prioritization)).
- `dev-dependencies` — every package in the PR is a dev dependency.

Labeling needs no permission beyond the `pull-requests: write` you already grant
to open the PR — GitHub's label API accepts either `issues` or `pull-requests`
write, so depvisor creates any missing label (without overwriting a same-named
label you already have) and applies it with that scope alone. It is also
**fail-soft**: labeling happens after the PR is opened and never blocks it, and a
label that somehow cannot be applied is logged and skipped rather than failing
the run. Label names are a fixed set today; a configurable/opt-out input may come
later.

## When tests change in an update

depvisor's confidence in an update rests on your checks passing — which only
means something if the tests stayed as strong as they were before. But when the
fixer agent adapts your code to a changed API, it sometimes has to touch tests
legitimately, so depvisor cannot simply forbid test edits without blocking honest
updates. Instead it makes them **visible**: after the update is committed, it
classifies the diff, and if any changed file looks like a test it adds a
**⚠️ Tests were modified in this update** section to the PR body (and the Actions
step summary) listing those files and their line counts. Nothing is blocked — the
warning just points your review at the one place the automated gate cannot vouch
for.

Detection is heuristic, based on common naming conventions (`test/`, `__tests__/`,
`*.test.*`, `*.spec.*`, and similar) rather than your test-runner's own config
(which lives in the repo the fixer can edit, and so cannot be trusted to define
what counts as a test). An empty section is therefore not a guarantee that no test
was touched — but the vast majority of updates need no fixer and change no tests at
all, and then no warning appears.

## When a dependency's license changes

A version bump can quietly carry a **relicense** (MIT → BUSL-1.1 and similar
source-available/copyleft moves are common in practice), which is among the
easiest changes to miss in review because it lives in metadata, not code. depvisor
compares the npm registry's per-version `license` field against the target
version, and when they differ it adds a **⚠️ License changed between versions**
section to the PR body listing `package: from → to`. In a workspace monorepo a
package can be installed at several versions at once, so it checks _every_ current
version the package is declared at — not just the lowest — and lists one row per
distinct license change, so a relicense crossed by only one workspace is not
hidden behind another. The packument this reads is the one already fetched for the
cooldown / source links, so it costs no extra registry requests.

This is **plain string comparison only** — depvisor makes no judgment about
whether the new license is more or less permissive (that reading is yours), it
just surfaces that the label changed. It is display-only and **fail-open**: a
license it cannot read as a clean string on both sides (the deprecated object
form, the ancient `licenses` array, a missing field, a private-registry package,
or a registry hiccup) simply shows nothing rather than blocking a PR, so an empty
section is not a guarantee that no license changed.

## Status reference

Run-level statuses describe the whole run and appear once; a red run-level
status stops the run. Group statuses describe one dependency group (one
prospective PR); a red group is recorded and skipped while the remaining groups
still run, but the job ends red.

Green — working as intended:

| Status               | Meaning                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`          | The run finished. The job can still be red when one of the groups below failed.                                                                               |
| `no-updates`         | No outdated dependencies (after the `ignore` rules and the cooldown).                                                                                         |
| `pr-prepared`        | The group's update passed every gate and its PR was opened or refreshed.                                                                                      |
| `pr-up-to-date`      | An open PR already covers exactly these target versions; the group was skipped.                                                                               |
| `deferred`           | The fixer could not safely make the breaking update pass your checks and said why; it is retried next run. Add the package to `ignore` if it keeps deferring. |
| `open-pr-blocked`    | A human pushed to the PR branch, so depvisor refuses to force-push over their commits. Merge or close the PR to hand the branch back.                         |
| `held-back-by-limit` | The `open_pull_requests_limit` ceiling is reached; the group is opened once an open depvisor PR is merged or closed.                                          |

Red — needs your attention (the annotation and run summary carry the specifics):

| Status                                                                                                                                                                 | Meaning — and what to do                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persisted-credentials`                                                                                                                                                | The checkout carries a token. Set `persist-credentials: false` on `actions/checkout`.                                                                                                                                                                                                                                                                                                                                              |
| `dirty-tree`                                                                                                                                                           | Uncommitted changes before any update — usually an install that wrote files git does not ignore. Extend `.gitignore` or fix `install_command`.                                                                                                                                                                                                                                                                                     |
| `unsupported-package-manager`                                                                                                                                          | The repo uses a package manager depvisor does not support (e.g. yarn).                                                                                                                                                                                                                                                                                                                                                             |
| `ambiguous-package-manager`                                                                                                                                            | Lockfiles of several package managers, with no `packageManager` field to disambiguate. Remove the stale lockfile or set the field.                                                                                                                                                                                                                                                                                                 |
| `bad-base-branch` / `missing-base-branch`                                                                                                                              | The base branch cannot be used or was not fetched. Set the `base_branch` input, or dispatch the run from the default branch.                                                                                                                                                                                                                                                                                                       |
| `no-verify-scripts`                                                                                                                                                    | package.json defines none of `build`/`lint`/`test`, so no gate can vouch for an update. Set `verify_commands`.                                                                                                                                                                                                                                                                                                                     |
| `bad-open-pull-requests-limit` / `bad-minimum-release-age` / `bad-minimum-release-age-exclude` / `bad-ignore` / `bad-groups` / `bad-suggest-features` / `bad-language` | The named input does not parse; the annotation shows the offending value.                                                                                                                                                                                                                                                                                                                                                          |
| `baseline-red`                                                                                                                                                         | Your checks already fail on the base branch before any update. Fix the base first.                                                                                                                                                                                                                                                                                                                                                 |
| `reset-failed`                                                                                                                                                         | The tree reset between groups left the checks failing (e.g. a leaked build artifact). Re-run; if it persists, file an issue.                                                                                                                                                                                                                                                                                                       |
| `bump-failed`                                                                                                                                                          | The deterministic dependency bump or its install failed for a group (e.g. an npm `ERESOLVE`, a failed pnpm catalog edit, a package pinned inconsistently across workspaces via both `catalog:` and a plain version, or a hung install); the summary names the failing step and shows the output tail. The fixer cannot help (it may not touch manifests), so the group is skipped — usually a real dependency conflict to resolve. |
| `release-age-unavailable`                                                                                                                                              | The npm registry could not vouch for a version's age (network failure, or a private-registry package). Transient failures heal on the next run; list private-registry packages in `minimum_release_age_exclude`.                                                                                                                                                                                                                   |
| `reinstall-unavailable`                                                                                                                                                | Multi-group runs need a reinstall between groups, but `install_command: skip` with no committed lockfile leaves no way to run one. Commit a lockfile or set `install_command`.                                                                                                                                                                                                                                                     |
| `branch-collision`                                                                                                                                                     | Two group names slugify to the same branch (rare — e.g. `@babel/core` vs `babel-core`). `ignore` one of the two packages.                                                                                                                                                                                                                                                                                                          |
| `no-structured-result`                                                                                                                                                 | The fixer returned no validated result (tokens may still have been spent). Usually transient; if it recurs, consider a stronger `llm_model`.                                                                                                                                                                                                                                                                                       |
| `unexpected-commits` / `scope-violation`                                                                                                                               | Target install/verification code moved refs or authored files outside its boundary, the deterministic bump left changes beyond the mechanical update, or the fixer touched manifests/lockfiles/denied paths. State is restored or discarded and no unsafe commit is opened. Re-run; a recurrence is worth an issue.                                                                                                                |
| `verification-failed`                                                                                                                                                  | The update broke your checks and the fixer could not fix them; no PR. The step summary shows which command failed.                                                                                                                                                                                                                                                                                                                 |
| `no-changes`                                                                                                                                                           | The deterministic bump ran but changed nothing (the dependency was already at the target); no PR. Re-run; a recurrence is worth an issue.                                                                                                                                                                                                                                                                                          |
| `open-pr-failed`                                                                                                                                                       | The push or PR creation failed — most often the "Allow GitHub Actions to create and approve pull requests" repository setting is off, or the workflow lacks `contents: write` / `pull-requests: write`.                                                                                                                                                                                                                            |
| `in-progress`                                                                                                                                                          | The run crashed mid-loop before writing a final status; the log has the failure. Groups recorded before the stop are intact.                                                                                                                                                                                                                                                                                                       |
