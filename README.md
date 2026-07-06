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
  pull-requests: write # open the PR

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

| Input                 | Purpose                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_api_key`         | (required) Provider API key — reaches **only** the agent step                                                                                                                                                                   |
| `llm_model`           | (required) Model specifier the key belongs to, e.g. `openai/gpt-5.5`, `anthropic/claude-sonnet-5`                                                                                                                               |
| `verify_commands`     | Newline-separated shell commands for the verification gate, replacing the automatic `build`/`lint`/`test` script detection                                                                                                      |
| `max_prs`             | Ceiling on the number of open depvisor PRs (default `1`). A run opens new PRs up to this limit and always refreshes the ones it already opened; raising it multiplies LLM calls and CI time roughly linearly                    |
| `minimum_release_age` | Minimum number of days a version must have been public on the npm registry before depvisor updates to it (default `1`, matching pnpm's `minimumReleaseAge`). `0` disables the cooldown — required for private-registry packages |
| `ignore`              | Newline-separated packages to never update. `name` skips a package entirely; `name@<major>` skips only updates whose target major is that number. Full version ranges and update-type rules are not supported yet                |

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
`minimum_release_age` days (default `1`, matching pnpm's `minimumReleaseAge`;
Renovate and Dependabot ship the same defense as `minimumReleaseAge`/`cooldown`).
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
  next scheduled run. If your repo uses private packages, set
  `minimum_release_age: 0` to disable the cooldown.
- **bun repos get exact pins while the cooldown is active**: bun resolves
  ranges at install time, so depvisor instructs `bun add <name>@<version>`
  (no `^`) to stop an install from reaching back into the cooldown window.
  Your manifest then carries an exact version instead of a caret range.
- **A clamped major can move between PRs as it matures**: while a new major is
  inside the cooldown window, depvisor may open a PR for an older minor (e.g.
  `depvisor/prod-foo`); once the major has aged, the update moves to its own
  `depvisor/major-foo` PR. The earlier PR is not closed automatically — close
  or merge it yourself, since it counts against `max_prs` until you do.

### Ignoring packages (`ignore`)

Some updates you simply do not want depvisor to keep trying: a major that clashes
with your Node version, a dependency that went commercial, a version you have
intentionally pinned. Without a way to say so, that dependency resurfaces every
scheduled run and burns an agent investigation only to fail or defer again. The
`ignore` input is the permanent, human-decided exclusion (Dependabot's `ignore`):

```yaml
ignore: |
  left-pad          # never update this package
  lru-cache@11      # allow updates, but not to the v11 major
```

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
  counts against `max_prs` until you do. (An `ignore` rule that only removes one
  member of a grouped PR, like `dev-minor`, refreshes that PR to drop the
  package.)
- **Typos fail loudly**: an unrecognized entry stops the run with `bad-ignore`
  rather than silently ignoring nothing.

By default depvisor keeps at most one open PR at a time. Raise `max_prs` to let a
single run open several PRs — one per dependency group — up to that many open
depvisor PRs at once. It fills empty slots as you merge or close existing PRs, and
always refreshes the PRs it already opened (a refresh does not consume a slot).
Each group runs its own agent session with a fresh reinstall in between, so a
higher `max_prs` costs proportionally more LLM calls and CI time. The
between-groups reinstall happens even with `install_command: skip` (which only
skips the install before the first group) and uses the package manager's
lockfile-faithful install — so multi-group runs need a committed lockfile;
without one, groups after the first are reported as `reinstall-unavailable`.

### Reading the Actions result

depvisor writes a job summary and an annotation for every known outcome, at both
the run level and per group. Benign outcomes (`no-updates`, `pr-up-to-date`,
`deferred`, `open-pr-blocked` when a human has taken over the PR branch, and
`held-back-by-limit` when the `max_prs` ceiling is reached) stay green and explain
why no PR was opened. Updates the `minimum_release_age` cooldown clamped or held
back are likewise normal operation: they stay green and are listed in the run
summary. Outcomes that need attention (`baseline-red`, `reset-failed`,
`no-verify-scripts`, `missing-base`, `scope-violation`, `verification-failed`,
`reinstall-unavailable`, `release-age-unavailable`, `bad-ignore`, `open-pr-failed`,
and similar fail-closed stops) fail the job so they are not missed in scheduled
runs — a run stays red if any of its groups failed.

The step summary has a section per group depvisor touched, each with its branch,
package version table, verification results, and the PR URL when one was created
or refreshed. Baseline and post-update verification output is grouped in the log
so repeated test output is easier to scan.
