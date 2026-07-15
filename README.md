# depvisor

Aftercare for dependency-update PRs. Dependabot, Renovate, and similar tools
already discover updates, select versions, edit dependency state, and open
PRs — depvisor consumes those existing PRs and does the work that still
commonly falls to a human:

1. understand the dependency change in the context of the repository;
2. explain relevant upstream changes and concrete risks;
3. repair source or tests when the update breaks deterministic verification;
4. prove that an accepted repair passes the configured checks; and
5. publish a bounded repair commit and an evidence-grounded reviewer report.

The promise: **turn a dependency-update PR into a green, reviewable PR without
taking ownership of dependency selection or PR lifecycle from the updater.**
depvisor never opens PRs, never edits a PR's title or body, never chooses
versions, and never touches dependency state (manifests, lockfiles). It pushes
at most one verified repair commit onto the updater's own branch and maintains
one report comment on the PR. The final merge decision stays with you.

The split is by trust: the dependency diff, install, and **all** verification
are deterministic; an LLM is used only for the two jobs that need judgment —
repairing source breakage when the checks fail (the fixer), and writing the
reviewer report (the digest) — each boxed between deterministic gates. It is
LLM-provider-agnostic (bring your own API key: OpenAI, Anthropic, …) and ships
as a GitHub Action.

> depvisor currently supports npm, pnpm, and bun projects; yarn stops with a
> clear error rather than guessing.

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
  pull_request:
    types: [opened, synchronize, reopened]

permissions: {}

concurrency:
  group: depvisor-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  aftercare:
    # Run only on updater-authored PRs; add your Renovate bot's login if you
    # use one (e.g. 'renovate[bot]').
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write # push the repair commit onto the PR head branch
      pull-requests: write # create/update the report comment
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
          # The PR head branch itself (not the merge ref): the repair commit
          # is published onto it. fetch-depth: 0 so the merge base with the
          # base branch is computable.
          ref: ${{ github.event.pull_request.head.ref }}
          fetch-depth: 0
          persist-credentials: false # required — depvisor refuses persisted tokens

      - uses: morinokami/depvisor@v2 # or pin a commit SHA for production; see Versioning below
        with:
          llm_api_key: ${{ secrets.LLM_API_KEY }}
          llm_model: openai/gpt-5.5 # or anthropic/claude-sonnet-5, ... (BYOK)
```

> [!IMPORTANT]
> Workflows triggered by **Dependabot** PRs read secrets from the repository's
> _Dependabot secrets_ store (Settings → Secrets and variables → Dependabot),
> so register your LLM API key there too. The `permissions:` block above
> elevates the default read-only Dependabot `GITHUB_TOKEN`. Renovate-authored
> PRs (and PRs from other bot accounts) use your normal Actions secrets.

That's it. On every updater PR head, depvisor verifies the update against your
build/test suite; if it breaks, it proves the merge base was green (so the
failure is attributable to the update), repairs the source with a bounded AI
fixer, re-verifies, and pushes a `fix: adapt code to <package> update` commit
to the PR. Either way it posts (or updates) one report comment: what changed
upstream, what it means for this repository, what was repaired, and what a
reviewer should double-check.

### Prerequisites

- A dependency updater (Dependabot, Renovate, …) already opening PRs — depvisor
  does not discover or select updates.
- The checkout must be the PR's **head branch** with enough history to reach
  the merge base (`fetch-depth: 0`), and must not persist credentials
  (`persist-credentials: false`; the actions/checkout default is `true`).
  depvisor keeps tokens away from the AI agent and from the target's install
  scripts, so it fails at startup if it finds credentials in the checkout.
- package.json defines at least one of `build` / `lint` / `test`, or the
  `verify_commands` input names your checks explicitly. These checks must pass
  on the PR's base for a repair to be attempted.
- The repo uses npm, pnpm, or bun, with a committed lockfile (the baseline
  attribution reinstalls need it). bun repos also need the bun binary on the
  runner (`oven-sh/setup-bun`, version pinned).
- `.gitignore` covers `node_modules/` and build output (depvisor refuses dirty
  trees).
- You pay for the LLM calls with your own API key.

## What lands on the PR

- **A repair commit** (only when needed): committed by `depvisor[bot]`,
  bounded to source and tests — the scope gate rejects any manifest, lockfile,
  CI/config, or hook change, because the updater owns dependency state. Pushed
  fast-forward only, and only while the PR head is exactly the commit depvisor
  analyzed; if the updater rebased mid-run, nothing is pushed and the next
  trigger re-runs on the new head.
- **A report comment**, updated in place run after run (one per PR, marker-
  deduplicated):
  - the dependency change (lockfile-resolved versions, direct vs transitive),
  - a deterministic verdict (green as-is / repaired / needs a human),
  - LLM-written, sanitized narrative: what the upstream changes mean for this
    codebase, breaking changes addressed, risks and review notes,
  - a warning when the repair touched test files,
  - the verification results.

Note: pushes made with the default `GITHUB_TOKEN` do not trigger your other
workflows (GitHub's recursion guard), so a depvisor repair commit does not
re-run CI on the PR by itself — pass a GitHub App / PAT token as
`github_token` if you want that.

## Safety model (short version)

- **Token separation is structural**: the AI agent step holds only the LLM
  key; the GitHub token exists only in the publish step. The agent cannot run
  git or GitHub operations, and its repository access goes through bounded,
  repo-jailed tools.
- **Deterministic gates decide, the LLM proposes**: verification runs outside
  the agent, the scope gate rejects out-of-bounds edits, and the repair range
  is re-verified structurally (descent, committer, diff scope) at the
  token-holding publish boundary.
- **Attribution before repair**: a repair is only attempted when the merge
  base verifies green and the PR head does not — a broken base stops the run
  (`baseline-red`) instead of producing an unattributable "fix".
- **Human work is respected**: a PR whose commits touch anything beyond
  dependency state (someone pushed real work onto the branch) is skipped
  (`not-an-update-pr`), and a branch that moved mid-run is never overwritten
  (fast-forward-only compare-and-swap push).

See [docs/results.md](docs/results.md) for the full status vocabulary and
[docs/configuration.md](docs/configuration.md) for every input.

### Inputs

| Input             | Default                     | What it does                                                   |
| ----------------- | --------------------------- | -------------------------------------------------------------- |
| `llm_api_key`     | (required)                  | LLM provider API key; only the token-free agent step sees it.  |
| `llm_model`       | (required)                  | Model specifier, e.g. `openai/gpt-5.5`.                        |
| `llm_api_key_env` | inferred                    | Env var name for the key, for providers depvisor cannot infer. |
| `github_token`    | `${{ github.token }}`       | Used only by the publish step (push + comment).                |
| `pr_number`       | from the PR event           | The updater PR's number.                                       |
| `base_ref`        | from the PR event           | The PR's base branch.                                          |
| `head_ref`        | from the PR event           | The PR's head branch (must be checked out).                    |
| `install_command` | `auto`                      | `auto` / `skip` / a custom install command.                    |
| `verify_commands` | auto-detect build/lint/test | Newline-separated commands; replaces auto-detection.           |
| `language`        | English                     | BCP-47 tag for the report's narrative text.                    |
| `node_version`    | `24`                        | Node for depvisor and your verification scripts.               |

Outputs (`status`, `failed`, `repaired`, `comment_url`, `total_tokens`,
`est_cost_usd`) are machine-shaped and safe to branch on from `if: always()`
steps — see [docs/results.md](docs/results.md).

## Versioning

Pin a commit SHA for production use, or track the movable `v2` major tag.
Releases follow release-please; see the [CHANGELOG](CHANGELOG.md).

## Coming from depvisor v1?

v1 was a dependency updater: it scanned for outdated packages, applied bumps,
grouped them, and opened its own PRs. v2 intentionally removes all of that —
discovery, version selection, grouping, cooldowns, `ignore` rules, PR
creation, and conflict refresh are the updater's job now. Run Dependabot or
Renovate for those (their `groups`/`cooldown`/`ignore` features replace v1's
inputs one-for-one), and point depvisor at their PRs. There is no
compatibility mode; the trigger, inputs, outputs, statuses, and branch
ownership all changed.

## Development

```bash
pnpm install
pnpm test                    # unit tests, no API key needed
pnpm run fixture:init        # throwaway target repo with an updater-style PR branch
node src/dev/scan.ts fixtures/sample-app --base=main --verify=broken   # deterministic core E2E
DEPVISOR_TARGET_REPO="$PWD/fixtures/sample-app" pnpm exec flue run aftercare   # full agent run (.env: API key + DEPVISOR_LLM_MODEL)
```

See [CLAUDE.md](CLAUDE.md) for the full command and architecture reference.

## License

MIT
