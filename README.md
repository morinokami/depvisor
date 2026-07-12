# depvisor

A GitHub Action that updates your dependencies, fixes any breakage the update causes
with an AI agent, verifies the result with your build/test suite, and opens a
Dependabot/Renovate-style PR.

Unlike rule-based updaters, depvisor does not stop at bumping a version: it applies the
update and runs your build/test suite deterministically, and when the update breaks
them, an AI agent reads the codebase and the release notes and makes the code fixes
needed to get your checks passing again. A read-only agent then explains the change (and
any risks) in the PR body. It is LLM-provider-agnostic (bring your own API key:
OpenAI, Anthropic, …) and ships as a GitHub Action. The final merge decision stays with
you.

> depvisor currently supports npm, pnpm, and bun projects and updates direct
> dependencies only; yarn stops with a clear error rather than guessing.

## Use it in your repository

Paste this prompt into your coding agent and it will inspect your repository,
tailor the workflow to it, and walk you through the rest:

> Read https://raw.githubusercontent.com/morinokami/depvisor/main/start.md and
> set up depvisor in this repository.

Setting it up by hand instead: add one workflow and one secret (your LLM API
key):

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

      - uses: morinokami/depvisor@v1 # or pin a commit SHA for production; see Versioning below
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
- The repo uses npm, pnpm, or bun, with a committed lockfile. bun repos also
  need the bun binary on the runner (`oven-sh/setup-bun`, version pinned).
- `.gitignore` covers `node_modules/` and build output (depvisor refuses dirty trees).
- You pay for the LLM calls with your own API key.
- Note: PRs opened with the default `GITHUB_TOKEN` do not trigger your other
  workflows (GitHub's recursion guard) — pass a GitHub App / PAT token as
  `github_token` if you want CI checks on depvisor PRs.

Workspace monorepos, pnpm `catalog:` pins, bun specifics, and running without a
committed lockfile (npm/pnpm only) are all supported with caveats — see
[Repository requirements](./docs/configuration.md#repository-requirements).

### Inputs

| Input                         | Purpose                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_api_key`                 | (required) Provider API key — reaches **only** the agent step                                                                                                                                                                                                                   |
| `llm_model`                   | (required) Model specifier the key belongs to, e.g. `openai/gpt-5.5`, `anthropic/claude-sonnet-5`                                                                                                                                                                               |
| `verify_commands`             | Newline-separated shell commands for the verification gate, replacing the automatic `build`/`lint`/`test` script detection                                                                                                                                                      |
| `open_pull_requests_limit`    | Ceiling on the number of open depvisor PRs (default `5`, matching Dependabot's `open-pull-requests-limit`). A run opens new PRs up to this limit and always refreshes the ones it already opened; raising it multiplies LLM calls and CI time roughly linearly                  |
| `minimum_release_age`         | Minimum number of days a version must have been public on the npm registry before depvisor updates to it (default `1` day). `0` disables the cooldown entirely                                                                                                                  |
| `minimum_release_age_exclude` | Newline-separated package names exempted from the cooldown's age check — for private-registry packages the public npm registry cannot vouch for (they would otherwise fail the run). Exact names or trailing-`*` prefix globs (`@acme/*`); full-line `#` comments allowed       |
| `ignore`                      | Newline-separated packages to never update. `name` skips a package entirely; `name@<major>` skips only updates whose target major is that number; `prefix*` skips every matching package; full-line `#` comments are allowed                                                    |
| `groups`                      | Newline-separated package groups updated together in one PR, each line `<group-name>: <package> <package> …` (members separated by spaces or commas). Exact names or trailing-`*` prefix globs, each package in at most one group; ungrouped packages keep getting their own PR |
| `suggest_features`            | `true` to also surface newly added capabilities relevant to your code as a display-only PR-body section (default `false`). Opt-in because it costs extra tokens and widens the agent's engagement with untrusted release notes                                                  |
| `language`                    | Restricted BCP-47-style language tag (e.g. `ja`, `pt-BR`) the agent writes the PR's narrative text in; empty (the default) means English. Only the LLM-written free text is localized — statuses, commit messages, branch names, PR titles, and section headings stay English   |

```yaml
# e.g. when your checks go by other names:
verify_commands: |
  npm run check
  npm run test:unit

# e.g. dependencies you have decided not to update:
ignore: |
  left-pad
  lru-cache@11

# e.g. packages that must move in lockstep, in one PR:
groups: |
  react: react react-dom @types/react
```

Every input above is documented in depth — behavior, edge cases, and failure
modes — in [docs/configuration.md](./docs/configuration.md). The remaining
inputs (`llm_api_key_env`, `github_token`, `base_branch`, `install_command`,
`node_version`) are documented with their defaults in
[`action.yml`](./action.yml).

### Outputs

The action exposes the run's result to the following steps of your workflow —
`status`, `failed`, `prepared_count`, and `pr_urls` — so you can branch and
notify on it. All values are deliberately machine-shaped (fixed-vocabulary
statuses, numbers, and strictly validated URLs, never the agent's free text),
so they are safe to consume. The output table, a consumption example, and the
full status vocabulary are in
[docs/results.md](./docs/results.md#action-outputs).

## Versioning

Pin depvisor the way you would any privileged third-party action — it handles
your tokens and opens PRs, so a version swapped out from under you is a real
supply-chain risk. **Pin to a full-length commit SHA** and keep the version in a
trailing comment; a SHA is the only truly immutable reference (a Git tag, even
`@v1.2.3`, can be force-moved — the vector behind recent Actions supply-chain
attacks), and it is how depvisor pins its own dependencies:

```yaml
- uses: morinokami/depvisor@<full-length-sha> # v1.2.3
```

Let [Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
or Renovate (the `github-actions` ecosystem) bump that SHA for you, so you keep
depvisor's own security fixes without giving up immutability.

Prefer convenience over that guarantee? The movable major tag
`morinokami/depvisor@v1` always points at the latest `v1.x` release — you get
patches and backward-compatible features without editing the pin, and a breaking
change bumps the major to `v2`, which you opt into deliberately (`@v1` never
rolls forward to `v2` on its own). It trades the supply-chain immutability above
for auto-updates.

Releases are cut from [Conventional Commits](https://www.conventionalcommits.org)
on `main` (`feat` → minor, `fix` → patch, `!`/`BREAKING CHANGE` → major), and the
[CHANGELOG](CHANGELOG.md) is generated per release.

## How depvisor works

depvisor keeps the LLM and GitHub token in separate steps. Token-holding steps
only snapshot existing PRs and push/open the final PR; the agent step gets only
the LLM key. Because a checkout that persists credentials would defeat this
separation from the outside, depvisor checks for persisted credentials first
and refuses to start if it finds any.

The agents also do not receive a host shell. Their built-in capabilities run in
Flue's in-memory workspace, isolated from the host filesystem, and reach the
target checkout only through bounded tools:
the digest can list, search, and read repo-relative files; the failure-only
fixer additionally gets repo-relative write/replace/remove operations. Paths are
resolved below the real target root (including symlinks), `.git` is unavailable,
and neither role can reach depvisor's own action checkout or rewrite the later
token-holding entrypoint.

Every PR updates exactly one package — majors, minors, and patches alike get
their own PR, the model of Dependabot without `groups` (in a workspace monorepo,
that one PR covers every workspace declaring the package). For each update,
deterministic code verifies the base branch, applies the dependency bump and
installs it, and runs your configured checks. When they pass, no fixer agent runs
at all. When the update breaks them, an AI agent reads the release notes and your
code and makes the minimal source fixes to get the checks passing again — it never
touches manifests or lockfiles, which the deterministic bump already owns.
Deterministic gates re-verify the final result before a PR is opened, reject any
tracked or untracked repository change made by install/verification scripts
outside their expected boundary, and repeat the fixer scope gate immediately
before the fix commit. Either way, a separate read-only agent writes the PR's
explanation.

The update branch uses a stable name, so reruns update the same PR instead of
creating duplicates. It contains up to two commits: `deps: bump …` for the manifest
and lockfile changes (made before any AI runs), and `fix: adapt code to …` for the
source fixes the AI made — present only when the update actually needed them.

### Going deeper

- [docs/configuration.md](./docs/configuration.md) — repository requirements in
  detail, and every behavior-shaping input: verification commands, the
  supply-chain cooldown (`minimum_release_age`), `ignore`, package grouping
  (`groups`), the PR ceiling (`open_pull_requests_limit`), security
  prioritization, opt-in feature suggestions, and the PR narrative's output
  language (`language`).
- [docs/results.md](./docs/results.md) — the job summary and annotations, the
  action outputs, PR labels, the test-change and license-change warnings, and
  the full [status reference](./docs/results.md#status-reference).
