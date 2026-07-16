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
5. posts one maintained, evidence-grounded reviewer report.

When a repair is needed, depvisor adds one commit to the existing updater branch.
It never opens a replacement PR. The final merge decision stays with you.

> v2 is intentionally incompatible with v1. v1 was a dependency updater; v2 is
> an autonomous repair/review agent for PRs created by another updater.

## Setup

Add one secret named `LLM_API_KEY`, then add this workflow. Change `CI` in
`workflows: [CI]` when your verification workflow has another `name:`.

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

You can also ask a coding agent to install it:

> Read https://raw.githubusercontent.com/morinokami/depvisor/main/start.md and
> set up depvisor in this repository.

## What gets published

The updater-owned dependency state is frozen before the agent starts. This
includes every path in the original updater diff plus recognized manifests and
lockfiles across common ecosystems. If the agent changes any of it—or changes
Git history—depvisor publishes neither the repair nor its report.

Everything else is agent-driven. The agent may inspect and edit the checkout,
run commands, install tools, and research upstream sources. It does not receive
the GitHub token. A later transport step rechecks the PR head and frozen state,
then publishes the captured working-tree repair and updates a marker-deduplicated
PR comment.

Because the local agent shares the runner host, depvisor also snapshots its own
publisher source before model work. The token step clears inherited loader/shell
configuration and refuses to execute if that source changed. This reduces
cross-step tampering but does not turn `local()` into an OS isolation boundary.

Publication is bounded to at most 200 changed files and 5 MiB of captured
patch/new-file content. A larger migration is left for a human-sized review.

This is intentionally close to running Codex or Claude Code in an autonomous
mode on the PR. Repository files, dependency code, CI logs, and web pages are
untrusted model inputs. Use branch protection and require your normal CI before
merge; depvisor's report is review evidence, not a security attestation.

## Behavior

- Only open, same-repository PRs authored by Dependabot or Renovate are processed.
- A failed CI run gives the agent failed-job steps and bounded log tails.
- A green CI run still gets a repository-specific upstream review, normally
  without a code change.
- A repair is one commit pushed with a force-with-lease against the snapshotted
  PR head. A concurrent updater/human change causes a safe failure.
- The same PR comment is updated on later runs. A repair push naturally reruns
  CI; the following green run refreshes the evidence report without another
  commit when no further work is needed.
- The agent is ecosystem-agnostic. It uses whatever tools the GitHub runner and
  repository provide instead of depvisor maintaining package-manager logic.

See [configuration](docs/configuration.md) for the five inputs and
[results](docs/results.md) for outputs and statuses.

## Model providers

Known model prefixes infer the provider credential automatically:

- `openai/*` → `OPENAI_API_KEY`
- `anthropic/*` → `ANTHROPIC_API_KEY`
- `openrouter/*` → `OPENROUTER_API_KEY`

For another provider, set the optional `llm_api_key_env` input.

## Versioning

`morinokami/depvisor@v2` follows the latest v2 release. Pin an immutable commit
SHA when your supply-chain policy requires it. v1 remains the old standalone
updater and is not configuration-compatible with v2.

## License

[MIT](LICENSE)
