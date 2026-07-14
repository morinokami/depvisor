# depvisor

depvisor is dependency-update PR aftercare. It accepts an existing Dependabot or
Renovate pull request, explains the update in this repository, reproduces a
failing CI gate, proposes one bounded source/test repair when safe, proves the
candidate with deterministic commands, and publishes a reviewer report.

depvisor does **not** discover versions, edit manifests or lockfiles, group
updates, open PRs, resolve conflicts, rebase, merge, or auto-merge. The updater
continues to own dependency selection and branch lifecycle.

> Turn a dependency-update PR into a green, reviewable PR without taking
> ownership of dependency selection or PR lifecycle from the updater.

v2 is a breaking replacement for the v1 composite action. Consumers that still
want the standalone updater behavior can remain pinned to `@v1`.

## Why a reusable workflow?

depvisor is a multi-job security boundary, not a bundle of steps. Target install
and test code, the LLM credential, and the publisher credential must run on
separate ephemeral runners with different permissions. A composite action runs
inside one caller job and cannot create those boundaries. The small caller
workflow is intentional: it lets depvisor own the isolated job graph while the
repository explicitly owns the trigger and secret mapping.

## How it works

The trusted default-branch wrapper starts after one named aggregate CI workflow
finishes. depvisor resolves that workflow's exact head to one open PR and
attests Dependabot/Renovate from GitHub API actor and commit fields. It reads
`.github/depvisor.yml` from the current base-tip SHA, computes the three-dot
updater diff, and normalizes supported ecosystems.

If CI is green, depvisor reviews without running target code. If CI is red and
policy allows repair, separate ephemeral jobs verify a green base and stable red
head. Only then does the one-shot fixer edit source/tests through bounded tools.
A separate credential-free job verifies the exact patch. The publisher job
rechecks base/head ownership, patch hash, and scope in a fresh clone before a
normal push—never a force-push.

JavaScript package manifests and Go modules are currently `repair-safe`.
Unrecognized ecosystems still receive generic review when report policy selects
`unknown`, but never automatic repair.

## Setup

### 1. Add trusted base-branch configuration

Create `.github/depvisor.yml`:

```yaml
version: 2

repair:
  enabled: true
  update_types: [patch, minor, major, digest]

verification:
  prepare:
    - corepack enable
    - pnpm install --frozen-lockfile
  commands:
    - pnpm run check

updaters:
  dependabot:
    enabled: true
  renovate:
    enabled: true
    trusted_actors: [renovate[bot]]
    # Optional; otherwise stale Renovate branches require its retry checkbox.
    rebase_label: rebase

report:
  enabled: true
  update_types: [minor, major, unknown]
  language: en
  suggest_features: false

cost:
  max_dependencies_per_pr: 20
  max_llm_calls_per_pr: 2
```

`prepare` and `commands` are ecosystem-neutral shell contracts. They may call
`make`, `go test`, Cargo, Maven, a checked-in CI script, or any other toolchain.
They are read from the base SHA, never from the updater-controlled head.

### 2. Create a publisher GitHub App

Install a GitHub App on the repository with Contents, Pull requests, Issues, and
Checks write permissions. Store its Client ID and private key as
`DEPVISOR_APP_CLIENT_ID` and `DEPVISOR_APP_PRIVATE_KEY`. The publisher creates a
short-lived installation token only in its isolated job. A fine-grained PAT in
`DEPVISOR_PUBLISHER_TOKEN` is the explicit fallback.

The ordinary repository `GITHUB_TOKEN` is intentionally not used for repair
pushes because those pushes need to trigger the repository's next CI run.

### 3. Chain depvisor from one aggregate CI workflow

Create `.github/workflows/depvisor.yml` on the default branch:

```yaml
name: depvisor

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Updater PR number
        required: true
        type: number

permissions:
  actions: read # resolve the completed CI run
  contents: read
  pull-requests: read # resolve and attest the updater PR

jobs:
  aftercare:
    uses: morinokami/depvisor/.github/workflows/depvisor.yml@v2
    with:
      workflow_run_id: ${{ github.event.workflow_run.id || 0 }}
      pr_number: ${{ inputs.pr_number || 0 }}
      llm_model: openai/gpt-5.5
    secrets:
      llm_api_key: ${{ secrets.OPENAI_API_KEY }}
      publisher_app_client_id: ${{ secrets.DEPVISOR_APP_CLIENT_ID }}
      publisher_private_key: ${{ secrets.DEPVISOR_APP_PRIVATE_KEY }}
```

Use one aggregate CI workflow name to avoid duplicate runs. Do not use
`pull_request_target`, direct Dependabot PR secrets, or `secrets: inherit`.

The template follows the movable `v2` tag. For reviewed upgrades, pin the
reusable workflow to a full 40-character commit SHA and keep the release tag in
an end-of-line comment; Dependabot can update both the SHA and comment. Enable
its GitHub Actions updater with:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Whichever ref the caller selects, every job runs depvisor source from that exact
called-workflow commit; there is no independent source-ref input.

## Results

The reusable workflow exposes `status`, `pr`, and `repair_applied`. It also
upserts a marker-delimited PR comment, creates a `depvisor` Check, and stores the
typed `result.json` artifact. See [results](docs/results.md) for every terminal
status and [configuration](docs/configuration.md) for the complete schema.

## Security boundary

| Job                  | Target code | LLM credential | GitHub write credential |
| -------------------- | ----------- | -------------- | ----------------------- |
| Resolve/normalize    | No          | No             | No                      |
| Baseline/head verify | Yes         | No             | No                      |
| Reviewer/fixer       | No          | Yes            | No                      |
| Candidate verify     | Yes         | No             | No                      |
| Publisher            | No          | No             | App/PAT only            |

Artifacts crossing jobs are bounded and schema-validated. Checkout credentials
are never persisted. The reviewer is read-only; the fixer can only use jailed
repo-relative tools and cannot reach `.git`, the depvisor source checkout, or a
host shell.

## Development

Node 24+ and pnpm are required.

```bash
pnpm test
pnpm run check
actionlint
zizmor --persona=auditor --min-confidence=high .
```

See [start.md](start.md) for the self-contained agent setup guide.
