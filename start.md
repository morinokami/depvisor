# Set up depvisor v2

You are configuring depvisor in the repository currently open in your coding
environment. depvisor consumes existing Dependabot or Renovate PRs after normal
CI finishes. It does not select or update dependencies itself.

## 1. Identify the CI workflow name

Inspect `.github/workflows/` and find the workflow that represents the complete
required build/test/lint suite for pull requests. Its top-level `name:` is used
by `workflow_run`. In the template below it is `CI`; replace that value if the
repository uses another name.

The CI workflow must run for Dependabot/Renovate PRs. Do not add model or GitHub
credentials to that untrusted PR workflow.

## 2. Add the depvisor workflow

Create `.github/workflows/depvisor.yml`:

```yaml
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

Keep the action's minimal configuration at those two inputs unless the user asks
for another provider. `persist-credentials: false` and the exact head SHA are
required: depvisor refuses a credentialed or stale checkout.

For Anthropic use a model such as `anthropic/claude-sonnet-5`; for OpenRouter use
`openrouter/<model>`. Those prefixes infer the credential variable. An unusual
provider also needs `llm_api_key_env`.

## 3. Ask the user to add the secret

Tell the user to add the repository Actions secret `LLM_API_KEY` containing the
provider key. Never request or handle the secret value yourself.

## 4. Explain the authority

Tell the user that v2 intentionally runs a coding agent in Flue's local sandbox.
It can read and edit the checkout, execute runner commands, install target tools,
and access the network. It does not receive the GitHub token or provider key in
its model-directed shell, but it processes untrusted PR content, CI logs,
dependency code, and web pages.

Be explicit that environment-variable omission is not credential isolation. The
agent and later token-holding publisher run in the same job as the same runner
user. Source hashing and a scrubbed child environment do not stop a background
process, runner-tool/PATH replacement, temporary status-file tampering, or a
malicious dependency install script from interfering with the later step. Use a
fresh GitHub-hosted runner; do not recommend a shared or persistent self-hosted
runner for this workflow.

depvisor freezes the updater's original changed paths and recognized dependency
state. If the agent changes any of it, or changes Git history, no repair or report
is published. Otherwise a later token-holding step may push one repair commit to
the existing updater branch and update one reviewer-report comment.

Recommend normal branch protection and required CI. depvisor evidence is not a
security attestation and does not replace human review.

## 5. Validate the workflow

Check the YAML syntax and confirm:

- the name in `workflows: [...]` exactly matches the verification workflow;
- checkout uses `workflow_run.head_sha`, fetches history for the updater diff,
  and disables persisted credentials;
- permissions are scoped to `actions: read`, `contents: write`, and
  `pull-requests: write` on the job;
- the workflow itself is committed to the default branch, because GitHub only
  delivers `workflow_run` to workflows present there; and
- Dependabot or Renovate is configured separately and already creates PRs.

Then summarize the files changed and the one manual secret-setting step.

## Result vocabulary

Green: `reviewed`, `repair-published`, `deferred`, `unsupported-pr`, `stale-pr`.

Failing: `setup-failed`, `wrong-head`, `agent-failed`,
`dependency-state-changed`, `publish-failed`, `in-progress`.

See `docs/configuration.md` and `docs/results.md` in the depvisor repository for
the complete reference.
