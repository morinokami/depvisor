# depvisor

depvisor turns an existing Dependabot or Renovate pull request into a green,
reviewable PR. It does not discover dependencies, select versions, edit lockfiles,
group updates, or create PRs. The updater keeps ownership of those jobs.

After your normal CI finishes, depvisor gives an AI coding agent the PR checkout,
shell, installed runner tools, and network access. The agent:

1. understands the dependency change in this repository;
2. reads failed CI logs and relevant upstream documentation;
3. repairs source, tests, or configuration when appropriate;
4. runs the checks needed to support its conclusion; and
5. posts one evidence-based reviewer report, updated on later runs.

When a repair is needed, depvisor adds one commit to the existing updater branch.
It never opens a replacement PR. The final merge decision stays with you.

## Setup

The quickest way is to ask a coding agent to install it:

> Read https://raw.githubusercontent.com/morinokami/depvisor/main/start.md and
> set up depvisor in this repository.

To set it up by hand instead: add one secret named `LLM_API_KEY`, then add this
workflow. Change `CI` in `workflows: [CI]` when your verification workflow has
another `name:`.

```yaml
# .github/workflows/depvisor.yml
name: depvisor

on:
  workflow_run:
    workflows: [CI]
    types: [completed]

permissions: {}

concurrency:
  group: depvisor-${{ github.event.workflow_run.head_branch }}
  cancel-in-progress: true

jobs:
  repair:
    if: github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      actions: read
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
          fetch-depth: 0
          persist-credentials: false

      - uses: morinokami/depvisor@v2
        with:
          llm_api_key: ${{ secrets.LLM_API_KEY }}
          llm_model: openai/gpt-5.5
```

That two-input `uses:` step is the complete minimum depvisor configuration. The
PR number, head SHA, failed jobs, logs, repository, GitHub API, and token are
derived from the `workflow_run` event.

## Model providers

Known model prefixes infer the provider credential automatically:

- `openai/*` → `OPENAI_API_KEY`
- `anthropic/*` → `ANTHROPIC_API_KEY`
- `openrouter/*` → `OPENROUTER_API_KEY`

For another provider, set the optional `llm_api_key_env` input.

## Behavior

- Only open, same-repository PRs authored by the recognized Dependabot or
  Renovate bot accounts are processed.
- A failed CI run gives the agent the PR diff plus the failed jobs and their
  log tails.
- A green CI run still gets a review of the upstream changes as they affect
  your repository, normally without a code change.
- A repair is one commit force-pushed with `--force-with-lease`, expecting the
  snapshotted PR head. A concurrent updater/human change supersedes the run
  without making the depvisor job fail.
- The same PR comment is updated on later runs. A repair push made with the
  default `github_token` does not trigger the next depvisor pass by itself:
  GitHub can hold the repaired head's CI run for manual approval, and its
  completion is not delivered back to `workflow_run`. The repair commit and
  full report are already on the PR at that point; the next updater- or
  human-initiated green run refreshes the report without another commit when
  no further work is needed.
- The agent is ecosystem-agnostic. It uses whatever tools the GitHub runner and
  repository provide instead of depvisor maintaining package-manager logic.

See [configuration](docs/configuration.md) for the five inputs and
[results](docs/results.md) for outputs and statuses.

## What gets published

The updater-owned dependency state is frozen before the agent starts. This
includes every path in the original updater diff plus recognized manifests and
lockfiles across common ecosystems. If the agent changes any of it—or changes
Git history—depvisor publishes neither the repair nor its report.

Everything else is agent-driven. The agent may inspect and edit the checkout,
run commands, install tools, and research upstream sources. It does not receive
the GitHub token. A later publish step rechecks the PR head and frozen state,
then pushes the captured working-tree repair and updates a single PR comment
identified by a hidden marker.

Publication is bounded to at most 200 changed files and 5 MiB of captured
patch/new-file content. A larger migration is left for human review.

## Security model

Running depvisor is intentionally close to running Codex or Claude Code in an
autonomous mode on the PR. Repository files, dependency code, CI logs, and web
pages are untrusted model inputs, and the target's install scripts execute on
the runner. depvisor keeps the GitHub token out of the agent's environment and
verifies its own publisher source before the token-holding steps run, but the
agent and publisher still share one job and one runner user — this is not an OS
isolation boundary.

Accept it the way you would an autonomous coding agent: run depvisor only on
ephemeral GitHub-hosted runners, keep branch protection with your normal CI as
the merge gate, and treat the report as review evidence, not a security
attestation. The [configuration docs](docs/configuration.md) describe the
remaining same-job risks in detail.
