# Set up depvisor v2

You are configuring depvisor in the repository currently open in your coding
environment. depvisor consumes existing Dependabot or Renovate PRs after normal
CI finishes. It does not select or update dependencies itself.

## 1. Confirm the model provider

Ask the user which LLM provider and model depvisor should use before writing
any file; propose `openai/gpt-5.5` as a default only when they have no
preference. The secret in step 4 must hold that provider's key, so never
proceed on a guessed provider. The prefixes `openai/*`, `anthropic/*` (for
example `anthropic/claude-sonnet-5`), and `openrouter/*` infer the credential
variable automatically; any other provider also needs the `llm_api_key_env`
input.

## 2. Identify the CI workflow name

Inspect `.github/workflows/` and find the workflow that represents the complete
required build/test/lint suite for pull requests. Its top-level `name:` is used
by `workflow_run`. In the template below it is `CI`; replace that value if the
repository uses another name. A workflow without `name:` is addressed by its
file path, which GitHub treats as the name — prefer adding a `name:`. If the
repository has no PR verification workflow at all, stop and tell the user that
depvisor needs one first: it consumes that workflow's conclusion and logs.

The CI workflow must run for Dependabot/Renovate PRs. Do not add model or GitHub
credentials to that untrusted PR workflow.

## 3. Add the depvisor workflow

Create `.github/workflows/depvisor.yml`, substituting the model chosen in
step 1:

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
  review:
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

Keep the action's minimal configuration at those two inputs unless the chosen
provider requires `llm_api_key_env`. `persist-credentials: false` and the exact
head SHA are required: depvisor refuses a credentialed or stale checkout.

## 4. Ask the user to add the secret

Tell the user to add the repository Actions secret `LLM_API_KEY` containing the
key for the provider chosen in step 1, and name that provider explicitly. They
can run `gh secret set LLM_API_KEY` or use Settings → Secrets and variables →
Actions. Never request or handle the secret value yourself.

## 5. Explain what the agent can do

Tell the user that v2 intentionally runs a coding agent in Flue's local sandbox.
It can read and edit the checkout, execute runner commands, install target tools,
and access the network. It does not receive the GitHub token or provider key in
its shell environment, but it processes untrusted PR content, CI logs,
dependency code, and web pages.

Be explicit that environment-variable omission is not credential isolation. The
agent and later token-holding publisher run in the same job as the same runner
user. Source hashing and a scrubbed child environment do not stop a background
process, runner-tool/PATH replacement, temporary status-file tampering, or a
malicious dependency install script from interfering with the later step. Use a
fresh GitHub-hosted runner; do not recommend a shared or persistent self-hosted
runner for this workflow.

depvisor freezes the updater's original changed paths and recognized dependency
files. If the agent changes any of them, or changes Git history, no fix or report
is published. Otherwise a later token-holding step may push one fix commit to
the existing updater branch and update one reviewer-report comment.

Also tell the user what happens after a fix lands. The commit is pushed with
the default `GITHUB_TOKEN`, so GitHub can hold the new head's CI run for
manual approval and does not start another depvisor pass from that completion.
The fix commit and full report are already on the PR at that point: they
approve the gated CI run and merge on green. A GitHub App installation token
or PAT supplied as `github_token` makes the follow-up refresh pass automatic,
at the cost of a separately managed credential whose pushes can trigger
workflows; recommend scoping it to this repository and these permissions.

Recommend normal branch protection and required CI. depvisor evidence is not a
security attestation and does not replace human review.

## 6. Validate the workflow

Check the YAML syntax and confirm:

- the name in `workflows: [...]` exactly matches the verification workflow;
- checkout uses `workflow_run.head_sha`, fetches history for the updater diff,
  and disables persisted credentials;
- permissions are scoped to `actions: read`, `contents: write`, and
  `pull-requests: write` on the job;
- the workflow itself is committed to the default branch, because GitHub only
  delivers `workflow_run` to workflows present there — when you deliver this
  change as a pull request, tell the user depvisor activates only once that PR
  merges; and
- Dependabot or Renovate is configured separately and already creates PRs. If
  neither exists, offer to add a minimal `.github/dependabot.yml` as well;
  without an updater, depvisor has nothing to review.

Then summarize the files changed and the one manual secret-setting step.

## Result statuses

Green: `reviewed`, `already-reviewed`, `fix-pushed`, `deferred`,
`unsupported-pr`, `stale-pr`.

Failing: `setup-failed`, `head-mismatch`, `agent-failed`,
`dependency-files-changed`, `publish-failed`, `incomplete`.

See `docs/configuration.md` and `docs/results.md` in the depvisor repository for
the complete reference.
