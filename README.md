# depvisor

A GitHub Action that uses an AI agent to investigate dependency updates, make the
required code fixes, verify them, and open a Dependabot/Renovate-style PR.

Unlike rule-based updaters, depvisor reads the codebase, updates a dependency, **fixes
any breakage the update causes**, verifies with your build/test suite, and explains the
change (and any risks) in the PR body. It is **LLM-provider-agnostic** (bring your own
API key: OpenAI, Anthropic, …) and ships as a GitHub Action. The final merge decision
stays with you.

> **Status: alpha.** depvisor runs end-to-end on real repositories, but interfaces
> and configuration are still evolving. It currently supports npm, pnpm, and bun
> projects and updates direct dependencies only; yarn stops with a clear error
> rather than guessing.

## Use it in your repository

Add one workflow and one secret (your LLM API key):

```yaml
# .github/workflows/depvisor.yml
name: depvisor
on:
  schedule:
    - cron: "0 3 * * 1" # the schedule lives in YOUR workflow
  workflow_dispatch: {}

permissions:
  contents: write # push the update branch
  pull-requests: write # open the PR (and create/apply its labels)

concurrency:
  group: depvisor # runs must not race on force-push
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # Recommended: block unexpected network egress. Add your LLM provider
      # and any private package registries your repo needs.
      - uses: step-security/harden-runner@v2
        with:
          egress-policy: block
          allowed-endpoints: >
            github.com:443
            api.github.com:443
            codeload.github.com:443
            objects.githubusercontent.com:443
            *.actions.githubusercontent.com:443
            registry.npmjs.org:443
            api.osv.dev:443
            api.openai.com:443

      - uses: actions/checkout@v7
        with:
          persist-credentials: false # required — depvisor refuses persisted tokens

      - uses: morinokami/depvisor@v1
        with:
          llm_api_key: ${{ secrets.LLM_API_KEY }}
          llm_model: openai/gpt-5.5 # or anthropic/claude-sonnet-5, ... (BYOK)
```

### Prerequisites

- **Repo setting**: enable "Allow GitHub Actions to create and approve pull requests"
  (Settings → Actions → General → Workflow permissions), or PR creation fails.
- The checkout must not persist credentials: set `persist-credentials: false` on
  `actions/checkout` (the default is `true`). depvisor keeps tokens away from the
  AI agent and from the target's install scripts, so it fails at startup if it
  finds credentials in the checkout (an Authorization header in `.git/config`,
  a token embedded in a remote URL or `insteadOf` rewrite, a persisted SSH key,
  or a repo-local credential helper).
- package.json defines at least one of `build` / `lint` / `test`, or the
  `verify_commands` input names your checks explicitly. These checks must pass
  on the base branch before depvisor runs.
- The repo uses npm, pnpm, or bun, with a committed lockfile. For npm/pnpm, a repo that
  tracks no lockfile can still run by setting `install_command` explicitly to a command
  that does not create one. bun has no such escape hatch — it computes updates from the
  committed lockfile, not the installed tree, so a bun repo must commit `bun.lock` (or
  `bun.lockb`) to be updatable at all.
- bun repos additionally need the bun binary on the runner — GitHub-hosted runners do
  not preinstall it, so add [`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun)
  before the depvisor step, and pin `bun-version`: depvisor parses `bun outdated`'s
  table output (bun has no JSON mode), so an unpinned bun that drifts with releases is
  a breakage risk. The legacy binary `bun.lockb` works, but the text `bun.lock` keeps
  lockfile diffs reviewable (`bun install --save-text-lockfile --frozen-lockfile
--lockfile-only` migrates).
- **Workspace monorepos** (npm, pnpm, and bun `workspaces`) are supported: depvisor
  updates each dependency in the workspace(s) that already declare it, never the
  root. This needs the single shared lockfile at the repo root, and verification
  that runs from the root — a root `build`/`lint`/`test` script that exercises the
  workspaces (e.g. via `turbo`/`nx`, `--workspaces`, or `bun run --filter`), or
  explicit `verify_commands`. For bun, workspace `workspaces` globs must be a
  literal directory or a single-level `dir/*` (deeper globs fail closed). yarn
  workspaces are not supported.
- `.gitignore` covers `node_modules/` and build output (depvisor refuses dirty trees).
- You pay for the LLM calls with your own API key.
- Note: PRs opened with the default `GITHUB_TOKEN` do not trigger your other
  workflows (GitHub's recursion guard) — pass a GitHub App / PAT token as
  `github_token` if you want CI checks on depvisor PRs.

### Inputs

| Input                         | Purpose                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_api_key`                 | (required) Provider API key — reaches **only** the agent step                                                                                                                                                                                         |
| `llm_model`                   | (required) Model specifier the key belongs to, e.g. `openai/gpt-5.5`, `anthropic/claude-sonnet-5`                                                                                                                                                     |
| `verify_commands`             | Newline-separated shell commands for the verification gate, replacing the automatic `build`/`lint`/`test` script detection                                                                                                                            |
| `max_open_prs`                | Ceiling on the number of open depvisor PRs (default `1`). A run opens new PRs up to this limit and always refreshes the ones it already opened; raising it multiplies LLM calls and CI time roughly linearly                                          |
| `minimum_release_age`         | Minimum number of days a version must have been public on the npm registry before depvisor updates to it (default `1` day). `0` disables the cooldown entirely                                                                                        |
| `minimum_release_age_exclude` | Newline-separated package names exempted from the cooldown's age check — for private-registry packages the public npm registry cannot vouch for (they would otherwise fail the run). Full-line `#` comments are allowed                               |
| `ignore`                      | Newline-separated packages to never update. `name` skips a package entirely; `name@<major>` skips only updates whose target major is that number; full-line `#` comments are allowed. Full version ranges and update-type rules are not supported yet |

```yaml
# e.g. when your checks go by other names:
verify_commands: |
  npm run check
  npm run test:unit

# e.g. dependencies you have decided not to update:
ignore: |
  left-pad
  lru-cache@11
```

The remaining inputs (`llm_api_key_env`, `github_token`, `base_branch`,
`install_command`, `node_version`) are documented with their defaults in
[`action.yml`](./action.yml).

## How depvisor works

depvisor keeps the LLM and GitHub token in separate steps. Token-holding steps
only snapshot existing PRs and push/open the final PR; the agent step gets only
the LLM key. Because a checkout that persists credentials would defeat this
separation from the outside, depvisor checks for persisted credentials first
and refuses to start if it finds any.

For each update, deterministic code picks a stable dependency group and verifies
the base branch first. The agent then reads release notes, updates the dependency,
fixes any breakage, and gets your configured checks passing. Deterministic gates
verify the final result before a PR is opened.

The update branch uses a stable name, so reruns update the same PR instead of
creating duplicates. It contains two commits: `deps: bump …` for the manifest and
lockfile changes, and `fix: adapt code to …` for code changes written by the AI.

### Update cooldown (`minimum_release_age`)

Freshly published versions are the main carrier of supply-chain attacks: a
compromised release is published, and automatic updaters spread it within hours.
depvisor therefore refuses to update to a version younger than
`minimum_release_age` days (default `1` day).
This is enforced deterministically from the npm registry's publish timestamps,
before any AI is involved. If a dependency's latest version is too new, depvisor
updates to the newest version that **has** aged enough instead, and holds the
dependency back entirely when nothing newer than the installed version has —
the run summary lists every clamp and hold-back.

Details worth knowing:

- **Fail-closed**: when the npm registry cannot vouch for a version's age
  (network failure, or a package that does not exist on registry.npmjs.org —
  e.g. a private-registry package), that update is skipped and the job is
  marked red (`release-age-unavailable`). A transient failure heals on the
  next scheduled run. If your repo uses private packages, list them in
  `minimum_release_age_exclude` (next bullet) so the cooldown keeps defending
  everything else.
- **Private packages: exempt them per package, don't disable the defense**
  (`minimum_release_age_exclude`): newline-separated package names (full-line
  `#` comments allowed) skip the age check and update straight to the version
  the collector reports — the same escape hatch pnpm ships as
  `minimumReleaseAgeExclude`.

  ```yaml
  minimum_release_age_exclude: |
    # our private packages — not on registry.npmjs.org
    @acme/design-tokens
    @acme/eslint-config
  ```

  The exemption is meant for packages the public registry cannot vouch for.
  Excluding a package that _does_ exist on npmjs removes a real supply-chain
  defense for it, so keep the list to your private packages. Typos fail loudly
  (`bad-min-release-age-exclude`), and `minimum_release_age: 0` remains the
  full disable.

- **bun repos get exact pins while the cooldown is active**: bun resolves
  ranges at install time, so depvisor instructs `bun add <name>@<version>`
  (no `^`) to stop an install from reaching back into the cooldown window.
  Your manifest then carries an exact version instead of a caret range.
- **A clamped major can move between PRs as it matures**: while a new major is
  inside the cooldown window, depvisor may open a PR for an older minor (e.g.
  `depvisor/prod-foo`); once the major has aged, the update moves to its own
  `depvisor/major-foo` PR. The earlier PR is not closed automatically — close
  or merge it yourself, since it counts against `max_open_prs` until you do.

### Ignoring packages (`ignore`)

Some updates you simply do not want depvisor to keep trying: a major that clashes
with your Node version, a dependency that went commercial, a version you have
intentionally pinned. Without a way to say so, that dependency resurfaces every
scheduled run and burns an agent investigation only to fail or defer again. The
`ignore` input is the permanent, human-decided exclusion (Dependabot's `ignore`):

```yaml
ignore: |
  left-pad
  # v11 needs a newer Node; revisit after our runtime upgrade
  lru-cache@11
```

(`left-pad` is never updated; `lru-cache` keeps updating, just not to the `11.x`
major. Full-line `#` comments are allowed — use them to record _why_ a package
is ignored; anything else must parse as `name` or `name@<major>`.)

Details worth knowing:

- **Deterministic and pre-agent**: ignored packages are dropped right after the
  outdated scan — before the cooldown, grouping, and any AI — so they cost no
  LLM call.
- **Trusted config only**: like `verify_commands`, `ignore` is read from the
  workflow file, never from the (agent-writable) target repository.
- **Ordering vs the cooldown**: `name@<major>` matches the registry's latest
  major. If `minimum_release_age` would clamp that major down to an older one
  anyway, the update was never going to that major, so the rule conservatively
  drops it a run early rather than letting it slip through.
- **Existing PRs are left alone**: adding a package to `ignore` does not close a
  PR depvisor already opened for it — close or merge it yourself, since it
  counts against `max_open_prs` until you do. (An `ignore` rule that only removes one
  member of a grouped PR, like `dev-minor`, refreshes that PR to drop the
  package.)
- **Typos fail loudly**: an unrecognized entry stops the run with `bad-ignore`
  rather than silently ignoring nothing.

By default depvisor keeps at most one open PR at a time. Raise `max_open_prs` to let a
single run open several PRs — one per dependency group — up to that many open
depvisor PRs at once. It fills empty slots as you merge or close existing PRs, and
always refreshes the PRs it already opened (a refresh does not consume a slot).
Each group runs its own agent session with a fresh reinstall in between, so a
higher `max_open_prs` costs proportionally more LLM calls and CI time. The
between-groups reinstall happens even with `install_command: skip` (which only
skips the install before the first group) and uses the package manager's
lockfile-faithful install — so multi-group runs need a committed lockfile;
without one, groups after the first are reported as `reinstall-unavailable`.

### Security prioritization

The most urgent dependency update is the one that closes a known vulnerability,
so depvisor processes those first. After grouping, it queries the
[OSV.dev](https://osv.dev) database and stable-promotes any group whose update
**resolves** a known advisory to the front of the run — ahead of routine
`@types/*` or dev-dependency bumps. This matters most with `max_open_prs`: security
fixes claim the run's PR slots before ordinary updates do. When a group is
prioritized, its PR body gains a **Security** column linking each resolved
advisory (`GHSA-…`) so a reviewer can see at a glance why the PR is worth merging
promptly.

Details worth knowing:

- **Ordering only**: prioritization never changes which version is installed —
  only the order groups are handled. It requires no configuration and is on by
  default.
- **Only genuine fixes are promoted**: a group is promoted only when the target
  version actually leaves the advisory's affected range. An advisory with no
  released fix yet (the current version is vulnerable and so is the latest) does
  not promote anything, because updating would not help.
- **The cooldown still wins**: prioritization runs on the version
  `minimum_release_age` would actually install, so a fix that is still inside the
  cooldown window is not treated as available yet — it is prioritized once it has
  aged enough. The supply-chain cooldown is never bypassed in the name of urgency.
- **Fail-soft**: unlike the cooldown, this is an optimization, not a defense. If
  OSV.dev is unreachable, depvisor falls back to the normal alphabetical order
  rather than failing the run, and says so in the run summary. If that note
  appears on every run, check that `api.osv.dev` is reachable from the runner
  (e.g. your egress allowlist). Private packages (absent from OSV) simply are
  not prioritized.

### PR labels

Every PR depvisor opens is labeled so you can build automation on top of it —
auto-merge rulesets, merge queues, notification filters, dashboards. depvisor
never merges anything itself (the final decision stays with you); it just hands
you structured signal. The labels are derived deterministically from the same
data the PR body shows:

- `depvisor` — on every PR, to select depvisor's PRs as a set.
- `semver:patch` / `semver:minor` / `semver:major` — the group's highest update
  level (majors are always their own PR, so a group mixes at most minor+patch).
- `security` — the update resolves at least one known advisory (see
  [Security prioritization](#security-prioritization)).
- `dev-dependencies` — every package in the PR is a dev dependency.

Labeling needs no permission beyond the `pull-requests: write` you already grant
to open the PR — GitHub's label API accepts either `issues` or `pull-requests`
write, so depvisor creates any missing label (without overwriting a same-named
label you already have) and applies it with that scope alone. It is also
**fail-soft**: labeling happens after the PR is opened and never blocks it, and a
label that somehow cannot be applied is logged and skipped rather than failing
the run. Label names are a fixed set today; a configurable/opt-out input may come
later.

### When the agent changes tests

depvisor's confidence in an update rests on your checks passing — which only
means something if the tests stayed as strong as they were before. But the agent
sometimes has to touch tests legitimately (an updated dependency changes an API a
test exercises), so depvisor cannot simply forbid test edits without blocking
honest updates. Instead it makes them **visible**: after the update is committed,
it classifies the diff, and if any changed file looks like a test it adds a
**⚠️ Tests were modified by the agent** section to the PR body (and the Actions
step summary) listing those files and their line counts. Nothing is blocked — the
warning just points your review at the one place the automated gate cannot vouch
for.

Detection is heuristic, based on common naming conventions (`test/`, `__tests__/`,
`*.test.*`, `*.spec.*`, and similar) rather than your test-runner's own config
(which lives in the repo the agent can edit, and so cannot be trusted to define
what counts as a test). An empty section is therefore not a guarantee that no test
was touched — but on the vast majority of updates the agent changes no tests at
all, and then no warning appears.

### When a dependency's license changes

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

### Reading the Actions result

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
— handy under BYOK, where you pay per run, and when raising `max_open_prs`, since cost
scales with the number of groups. The cost is a provider-priced estimate (shown
`est. ~$…`), not an invoice; groups that opened no agent session (skipped,
held back, or dropped before the agent) contribute nothing.

#### Status reference

Run-level statuses describe the whole run and appear once; a red run-level
status stops the run. Group statuses describe one dependency group (one
prospective PR); a red group is recorded and skipped while the remaining groups
still run, but the job ends red.

Green — working as intended:

| Status               | Meaning                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`          | The run finished. The job can still be red when one of the groups below failed.                                                       |
| `no-updates`         | No outdated dependencies (after the `ignore` rules and the cooldown).                                                                 |
| `pr-prepared`        | The group's update passed every gate and its PR was opened or refreshed.                                                              |
| `pr-up-to-date`      | An open PR already covers exactly these target versions; the group was skipped.                                                       |
| `deferred`           | The agent judged the update too risky and said why; it is retried next run. Add the package to `ignore` if it keeps deferring.        |
| `open-pr-blocked`    | A human pushed to the PR branch, so depvisor refuses to force-push over their commits. Merge or close the PR to hand the branch back. |
| `held-back-by-limit` | The `max_open_prs` ceiling is reached; the group is opened once an open depvisor PR is merged or closed.                              |

Red — needs your attention (the annotation and run summary carry the specifics):

| Status                                                                                    | Meaning — and what to do                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persisted-credentials`                                                                   | The checkout carries a token. Set `persist-credentials: false` on `actions/checkout`.                                                                                                                            |
| `dirty-tree`                                                                              | Uncommitted changes before any update — usually an install that wrote files git does not ignore. Extend `.gitignore` or fix `install_command`.                                                                   |
| `unsupported-package-manager`                                                             | The repo uses a package manager depvisor does not support (e.g. yarn).                                                                                                                                           |
| `ambiguous-package-manager`                                                               | Lockfiles of several package managers, with no `packageManager` field to disambiguate. Remove the stale lockfile or set the field.                                                                               |
| `bad-base` / `missing-base`                                                               | The base branch cannot be used or was not fetched. Set the `base_branch` input, or dispatch the run from the default branch.                                                                                     |
| `no-verify-scripts`                                                                       | package.json defines none of `build`/`lint`/`test`, so no gate can vouch for an update. Set `verify_commands`.                                                                                                   |
| `bad-max-open-prs` / `bad-min-release-age` / `bad-min-release-age-exclude` / `bad-ignore` | The named input does not parse; the annotation shows the offending value.                                                                                                                                        |
| `baseline-red`                                                                            | Your checks already fail on the base branch before any update. Fix the base first.                                                                                                                               |
| `reset-failed`                                                                            | The tree reset between groups left the checks failing (e.g. a leaked build artifact). Re-run; if it persists, file an issue.                                                                                     |
| `release-age-unavailable`                                                                 | The npm registry could not vouch for a version's age (network failure, or a private-registry package). Transient failures heal on the next run; list private-registry packages in `minimum_release_age_exclude`. |
| `reinstall-unavailable`                                                                   | Multi-group runs need a reinstall between groups, but `install_command: skip` with no committed lockfile leaves no way to run one. Commit a lockfile or set `install_command`.                                   |
| `branch-collision`                                                                        | Two group names slugify to the same branch (rare — e.g. `@babel/core` vs `babel-core`). `ignore` one of the two packages.                                                                                        |
| `no-structured-result`                                                                    | The agent returned no validated result (tokens may still have been spent). Usually transient; if it recurs, consider a stronger `llm_model`.                                                                     |
| `unexpected-commits` / `scope-violation`                                                  | The agent stepped outside its box (ran git, or touched denied paths); nothing was trusted or committed. Re-run; a recurrence is worth an issue.                                                                  |
| `verification-failed`                                                                     | The update broke your checks and the agent could not fix them; no PR. The step summary shows which command failed.                                                                                               |
| `no-changes`                                                                              | The agent reported success but changed nothing; no PR. Re-run; a recurrence is worth an issue.                                                                                                                   |
| `open-pr-failed`                                                                          | The push or PR creation failed — most often the "Allow GitHub Actions to create and approve pull requests" repository setting is off, or the workflow lacks `contents: write` / `pull-requests: write`.          |
| `in-progress`                                                                             | The run crashed mid-loop before writing a final status; the log has the failure. Groups recorded before the stop are intact.                                                                                     |
