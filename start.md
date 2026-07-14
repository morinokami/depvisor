# Set up depvisor v2

This page is self-contained for coding agents. depvisor v2 performs aftercare on
existing Dependabot/Renovate PRs. It never discovers/selects versions, edits
dependency state, groups updates, opens PRs, rebases, merges, or owns updater
branch lifecycle.

## 1. Confirm the repository gate

Choose one aggregate GitHub Actions workflow (usually `CI`) whose completed run
represents the repository's normal build/test gate. Keep that workflow on
ordinary `pull_request` semantics. Do not use `pull_request_target` for depvisor.

## 2. Add trusted configuration

Create `.github/depvisor.yml` on the default branch:

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
    # Optional automated regeneration handoff.
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

Replace `prepare`/`commands` with the repository's authoritative clean-checkout
contract. These commands may invoke any ecosystem. They are read from the PR
base-tip SHA. If repair is enabled/selected but `commands` is empty, the result
is `verification-unavailable`. Review-only `repair.enabled: false` needs no
commands.

JavaScript package manifests and Go modules currently support automatic repair.
Other ecosystems can receive generic review when `unknown` is selected but fail
closed for repair.

## 3. Configure secrets

Store the model key (for example `OPENAI_API_KEY`).

Create and install a GitHub App with Contents, Pull requests, Issues, and Checks
write permissions. Store:

- `DEPVISOR_APP_CLIENT_ID`
- `DEPVISOR_APP_PRIVATE_KEY`

A fine-grained `DEPVISOR_PUBLISHER_TOKEN` may be passed as the documented
fallback. Do not use the ordinary `GITHUB_TOKEN` for repair pushes; those pushes
must trigger the next repository CI run.

## 4. Add the default-branch wrapper

Create `.github/workflows/depvisor.yml`:

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
      llm_api_key_env: OPENAI_API_KEY
    secrets:
      llm_api_key: ${{ secrets.OPENAI_API_KEY }}
      publisher_app_client_id: ${{ secrets.DEPVISOR_APP_CLIENT_ID }}
      publisher_private_key: ${{ secrets.DEPVISOR_APP_PRIVATE_KEY }}
```

Map secrets explicitly; never use `secrets: inherit`. Name exactly one aggregate
workflow in `workflows: [CI]` so each PR head creates one aftercare run.

The template follows the movable `v2` tag. For reviewed upgrades, replace it
with a full 40-character commit SHA and retain the release tag in an end-of-line
comment. Dependabot updates remote reusable-workflow refs when the repository
enables its GitHub Actions updater:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Do not add or pass a second depvisor source ref. The called workflow executes
the exact depvisor commit selected by `jobs.aftercare.uses`.

## 5. Interpret outputs

Workflow outputs are `status`, `pr`, and `repair_applied`. The publisher also
upserts one PR comment, creates a `depvisor` Check, and uploads `result.json`.

Neutral statuses: `no-target`, `not-updater`, `policy-skipped`,
`updater-refresh-requested`, `stale-base`, `stale-head`, `human-takeover`.

Green statuses: `reviewed`, `repair-not-needed`, `repair-applied`.

Red statuses: `unsupported-provider`, `untrusted-updater`, `bad-config`,
`verification-unavailable`, `repair-unsupported`,
`updater-refresh-required`, `baseline-red`, `verification-unstable`,
`failure-not-reproduced`, `repair-deferred`, `verification-failed`,
`scope-violation`, `unexpected-commits`, `publish-failed`.

`in-progress` is a crash marker, not a terminal success. v1-only inputs and
outputs have no aliases in v2. Keep legacy updater consumers on `@v1`.
