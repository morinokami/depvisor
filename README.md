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
- `.gitignore` covers `node_modules/` and build output (depvisor refuses dirty trees).
- You pay for the LLM calls with your own API key.
- Note: PRs opened with the default `GITHUB_TOKEN` do not trigger your other
  workflows (GitHub's recursion guard) — pass a GitHub App / PAT token as
  `github_token` if you want CI checks on depvisor PRs.

### Inputs

| Input             | Purpose                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `llm_api_key`     | (required) Provider API key — reaches **only** the agent step                                                              |
| `llm_model`       | (required) Model specifier the key belongs to, e.g. `openai/gpt-5.5`, `anthropic/claude-sonnet-5`                          |
| `verify_commands` | Newline-separated shell commands for the verification gate, replacing the automatic `build`/`lint`/`test` script detection |

```yaml
# e.g. when your checks go by other names:
verify_commands: |
  npm run check
  npm run test:unit
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

### Reading the Actions result

depvisor writes a job summary and annotation for every known outcome. Benign
no-PR outcomes (`no-updates`, `pr-up-to-date`, `deferred`, and `open-pr-blocked`
when a human has taken over the PR branch) stay green and explain why no PR was
opened. Outcomes that need attention (`baseline-red`, `no-verify-scripts`,
`missing-base`, `scope-violation`, `verification-failed`, `open-pr-failed`, and
similar fail-closed stops) fail the job so they are not missed in scheduled runs.

The step summary includes the selected group, branch, package version table,
verification results, and the PR URL when one was created or refreshed. Baseline
and post-update verification output is grouped in the log so repeated test output
is easier to scan.
