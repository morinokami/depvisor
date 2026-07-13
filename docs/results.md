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

A `dry_run: true` summary additionally contains the candidate-to-plan table:
detected and ignored dependencies, cooldown outcomes, prioritized groups,
branch collisions, and PR dispositions. `open-new-provisional` and
`held-back-provisional` assume every earlier planned new PR succeeds; they are
forecasts, not claims that bump and verification will pass.

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

| Output           | Value                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`         | Run-level status (`completed`, `dry-run-completed`, `no-updates`, or a red status — see the [status reference](#status-reference)). Empty when the run crashed before reporting |
| `failed`         | `"true"` / `"false"` — whether the run fails the job. A `completed` run with one failed group is `"true"`, and so is a crash that never wrote a status                          |
| `prepared_count` | Number of dependency groups whose PR this run prepared (newly opened and refreshed alike)                                                                                       |
| `pr_urls`        | Newline-separated URLs of the PRs this run opened or refreshed                                                                                                                  |
| `total_tokens`   | Total LLM tokens used by every fixer and digest operation. `"0"` when no usage was recorded or the run crashed before reporting                                                 |
| `est_cost_usd`   | Provider-priced run-cost estimate in USD, as a six-decimal string. `"0.000000"` when no agent ran; empty when unavailable                                                       |

`est_cost_usd` is an estimate, not an invoice. Flue derives it from the active
model's pricing metadata; a model with no known price reports zero cost even
when it used tokens, so depvisor leaves this output empty rather than presenting
a partial or unknown estimate as `$0`. If one run mixes priced and unpriced
operations, the whole estimate is empty. A genuinely free model is
conservatively indistinguishable from an unpriced one with the current Flue
response and is empty for the same reason.

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

- name: Warn when estimated LLM spend exceeds $1
  if: >-
    always() &&
    steps.depvisor.outputs.est_cost_usd != '' &&
    fromJSON(steps.depvisor.outputs.est_cost_usd) > 1
  env:
    EST_COST_USD: ${{ steps.depvisor.outputs.est_cost_usd }}
  run: echo "::warning::depvisor estimated LLM cost was \$$EST_COST_USD"
```

One caveat: a known GitHub runner bug
([actions/runner#2009](https://github.com/actions/runner/issues/2009)) loses
step outputs when a composite action is nested inside _another_ composite
action — consume these outputs from workflow steps directly.

## PR labels

Every PR depvisor opens is labeled with deterministic review signals. Use them
to route reviews, notifications, and dashboards — for example, to put PRs whose
source was adapted by the fixer at the front of a review queue. depvisor never
merges anything itself (the final decision stays with you). The labels are
derived from trusted workflow facts and the same package data the PR body shows:

- `depvisor` — on every PR, to select depvisor's PRs as a set.
- `semver:patch` / `semver:minor` / `semver:major` — the update's semver level.
- `security` — the update resolves at least one known advisory (see
  [Security prioritization](./configuration.md#security-prioritization)).
- `dev-dependencies` — every package in the PR is a dev dependency.
- `fixer:none` — the PR has no accepted fixer commit. The deterministic bump
  passed verification without a source/test adaptation, or the fixer was
  invoked but produced no change that was committed.
- `fixer:applied` — the PR contains a `fix: adapt code to …` second commit whose
  source/test changes passed both fixer scope gates and post-fix verification.

`fixer:none` and `fixer:applied` are mutually exclusive. They come from whether
trusted workflow code actually created the second commit, never from the
agent's verdict or self-report.

Labeling needs no permission beyond the `pull-requests: write` you already grant
to open the PR — GitHub's label API accepts either `issues` or `pull-requests`
write, so depvisor creates any missing label (without overwriting a same-named
label you already have) and applies it with that scope alone. It is also
**fail-soft**: labeling happens after the PR is opened and never blocks it, and a
label that somehow cannot be applied is logged and skipped rather than failing
the run. On refresh, depvisor also removes obsolete labels from its own fixed
vocabulary (for example, an old `semver:patch` or `fixer:none`) while preserving
all labels outside that vocabulary. Reconciliation is best-effort for the same
reason. One asymmetry: `security` is removed only when that run's advisory
lookup succeeded — the lookup is fail-open, so during an advisory-endpoint
outage the label's absence is missing data, and an existing `security` label
stays rather than being stripped. Label names are a fixed set today; a
configurable/opt-out input may come later.

These labels describe **how depvisor prepared the PR**. They do not establish
the integrity or provenance of the package release: passing your configured
checks and carrying `fixer:none` show compatibility and the absence of an
accepted LLM-written source/test diff, not that dependency code is benign.
Patch releases and dev dependencies can still execute during install, build, or
test, and lockfile updates can bring transitive changes. Treat the labels as
review metadata, not a security attestation or, by themselves, a sufficient
basis for automatic merge. Dependency review, install-script policy, artifact
provenance, release age, secret isolation, and human review remain separate
controls.

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

| Status               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`          | The run finished. The job can still be red when one of the groups below failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dry-run-completed`  | The deterministic selection plan finished without applying updates or calling an LLM. It can still be red when the plan found a failing group condition such as `release-age-unavailable` or `branch-collision`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `no-updates`         | No outdated dependencies (after the `ignore` rules and the cooldown).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pr-prepared`        | The group's update passed every gate and its PR was opened or refreshed. A refresh summary says whether target versions drifted or the old branch conflicted with base.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pr-up-to-date`      | An open PR already covers exactly these target versions and was not known to conflict, so the group was skipped. If mergeability stayed `UNKNOWN` after polling, the summary says that conflict detection was deferred to the next run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `deferred`           | The fixer could not safely make the breaking update pass your checks and said why; it is retried next run. Add the package to `ignore` if it keeps deferring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `open-pr-blocked`    | An expected human intervention stopped the push: someone pushed to the PR branch, so depvisor refuses to force-push over their commits — including during conflict refresh. The first time it sees this on an open PR, depvisor leaves a fixed, best-effort comment explaining the stop; comment/read failures stay green, and later runs do not duplicate a marker-bearing comment. To hand the update back, merge or close the PR **and delete its head branch** (closing alone leaves the human commit at the remote tip). This status also covers a conflict-refresh-only target PR merged/closed while the run was in flight; there is then no open PR to comment on or refresh, and no new PR is opened. |
| `held-back-by-limit` | The `open_pull_requests_limit` ceiling is reached; the group is opened once an open depvisor PR is merged or closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Red — needs your attention (the annotation and run summary carry the specifics):

| Status                                                                                                                                                                                                               | Meaning — and what to do                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persisted-credentials`                                                                                                                                                                                              | The checkout carries a token. Set `persist-credentials: false` on `actions/checkout`.                                                                                                                                                                                                                                                                                                                                              |
| `dirty-tree`                                                                                                                                                                                                         | Uncommitted changes before any update — usually an install that wrote files git does not ignore. Extend `.gitignore` or fix `install_command`.                                                                                                                                                                                                                                                                                     |
| `unsupported-package-manager`                                                                                                                                                                                        | The repo uses a package manager depvisor does not support (e.g. yarn).                                                                                                                                                                                                                                                                                                                                                             |
| `ambiguous-package-manager`                                                                                                                                                                                          | Lockfiles of several package managers, with no `packageManager` field to disambiguate. Remove the stale lockfile or set the field.                                                                                                                                                                                                                                                                                                 |
| `bad-base-branch` / `missing-base-branch`                                                                                                                                                                            | The base branch cannot be used or was not fetched. Set the `base_branch` input, or dispatch the run from the default branch.                                                                                                                                                                                                                                                                                                       |
| `no-verify-scripts`                                                                                                                                                                                                  | package.json defines none of `build`/`lint`/`test`, so no gate can vouch for an update. Set `verify_commands`.                                                                                                                                                                                                                                                                                                                     |
| `bad-dry-run` / `bad-conflict-refresh-only` / `bad-open-pull-requests-limit` / `bad-minimum-release-age` / `bad-minimum-release-age-exclude` / `bad-ignore` / `bad-groups` / `bad-suggest-features` / `bad-language` | The named input does not parse; the annotation shows the offending value.                                                                                                                                                                                                                                                                                                                                                          |
| `baseline-red`                                                                                                                                                                                                       | Your checks already fail on the base branch before any update. Fix the base first.                                                                                                                                                                                                                                                                                                                                                 |
| `reset-failed`                                                                                                                                                                                                       | The tree reset between groups left the checks failing (e.g. a leaked build artifact). Re-run; if it persists, file an issue.                                                                                                                                                                                                                                                                                                       |
| `bump-failed`                                                                                                                                                                                                        | The deterministic dependency bump or its install failed for a group (e.g. an npm `ERESOLVE`, a failed pnpm catalog edit, a package pinned inconsistently across workspaces via both `catalog:` and a plain version, or a hung install); the summary names the failing step and shows the output tail. The fixer cannot help (it may not touch manifests), so the group is skipped — usually a real dependency conflict to resolve. |
| `release-age-unavailable`                                                                                                                                                                                            | The npm registry could not vouch for a version's age (network failure, or a private-registry package). Transient failures heal on the next run; list private-registry packages in `minimum_release_age_exclude`.                                                                                                                                                                                                                   |
| `reinstall-unavailable`                                                                                                                                                                                              | Multi-group runs need a reinstall between groups, but `install_command: skip` with no committed lockfile leaves no way to run one. Commit a lockfile or set `install_command`.                                                                                                                                                                                                                                                     |
| `branch-collision`                                                                                                                                                                                                   | Two group names slugify to the same branch (rare — e.g. `@babel/core` vs `babel-core`). `ignore` one of the two packages.                                                                                                                                                                                                                                                                                                          |
| `no-structured-result`                                                                                                                                                                                               | The fixer returned no validated result (tokens may still have been spent). Usually transient; if it recurs, consider a stronger `llm_model`.                                                                                                                                                                                                                                                                                       |
| `unexpected-commits` / `scope-violation`                                                                                                                                                                             | Target install/verification code moved refs or authored files outside its boundary, the deterministic bump left changes beyond the mechanical update, or the fixer touched manifests/lockfiles/denied paths. State is restored or discarded and no unsafe commit is opened. Re-run; a recurrence is worth an issue.                                                                                                                |
| `verification-failed`                                                                                                                                                                                                | The update broke your checks and the fixer could not fix them; no PR. The step summary shows which command failed.                                                                                                                                                                                                                                                                                                                 |
| `no-changes`                                                                                                                                                                                                         | The deterministic bump ran but changed nothing (the dependency was already at the target); no PR. Re-run; a recurrence is worth an issue.                                                                                                                                                                                                                                                                                          |
| `open-pr-failed`                                                                                                                                                                                                     | The push or PR creation failed — most often the "Allow GitHub Actions to create and approve pull requests" repository setting is off, or the workflow lacks `contents: write` / `pull-requests: write`.                                                                                                                                                                                                                            |
| `in-progress`                                                                                                                                                                                                        | The run crashed mid-loop before writing a final status; the log has the failure. Groups recorded before the stop are intact.                                                                                                                                                                                                                                                                                                       |
