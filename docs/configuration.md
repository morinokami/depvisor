# Configuration

depvisor v2 deliberately has a small configuration surface. Dependabot or
Renovate owns dependency selection and PR lifecycle; your existing CI owns the
project-specific check definitions. depvisor needs only a model and the event
context supplied by GitHub Actions.

## Inputs

| Input             | Default               | Description                                                                                                               |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `llm_api_key`     | none                  | Required provider API key. It is present in the Flue process but is not included in the model-directed shell environment. |
| `llm_model`       | none                  | Required Flue model specifier, such as `openai/gpt-5.5`.                                                                  |
| `llm_api_key_env` | inferred              | Provider environment variable. Inferred for `openai/*`, `anthropic/*`, and `openrouter/*`.                                |
| `github_token`    | `${{ github.token }}` | Reads the triggering workflow/jobs and publishes to the existing PR. It is absent from the agent step.                    |
| `node_version`    | `24`                  | Node version used to run depvisor itself; it does not select the target project's runtime.                                |

The minimum action configuration remains:

```yaml
- uses: morinokami/depvisor@v2
  with:
    llm_api_key: ${{ secrets.LLM_API_KEY }}
    llm_model: openai/gpt-5.5
```

## Workflow requirements

Use a `workflow_run` trigger for the workflow that verifies dependency PRs. This
solves two GitHub constraints at once: depvisor starts after CI has a conclusion
and logs, and the default-branch workflow can receive its secret when the
original PR was opened by Dependabot.

The job requires:

```yaml
permissions:
  actions: read
  contents: write
  pull-requests: write
```

Checkout `${{ github.event.workflow_run.head_sha }}` with `fetch-depth: 0` and
`persist-credentials: false`. Full history lets the agent inspect the exact base
diff; depvisor refuses a different head or persisted git credentials. It also
refuses fork branches and non-Dependabot/Renovate authors.

If several CI workflows should feed depvisor, list them under `workflows:`. Each
completion produces an independent review attempt, so prefer the single workflow
that represents your complete required CI suite.

## Agent environment

Flue's local sandbox gives the agent direct access to the checkout and host shell.
The default local environment exposes ordinary runner variables such as `PATH`,
`HOME`, locale, and temporary-directory paths, but not `GH_TOKEN` or the model
provider key. Network access is unrestricted so the agent can install the target
and consult ecosystem-specific upstream sources.

The agent additionally has two read-only evidence tools: `fetch_release_notes`
(GitHub releases with a CHANGELOG.md fallback) and `diff_npm_package` (the
published contents of two npm versions, as file lists plus a unified diff).
Both run unauthenticated against api.github.com, raw.githubusercontent.com, and
registry.npmjs.org only, validate every model-supplied coordinate, and cap the
returned text. They exist so the report's upstream claims cite sources the run
actually fetched; their output remains untrusted data like any other upstream
content.

This environment filtering prevents ordinary inheritance; it is not an OS
security boundary. depvisor hashes its own source before model work and the
token-holding steps refuse to run if it changed, starting their child processes
from a scrubbed environment. Still, the composite action runs agent and
publisher steps in the same job under the same UID, and those checks do not
stop a lingering background process, modification of runner-writable
toolchain/PATH entries, temporary status-file tampering, or malicious target
install scripts from observing or interfering with a later token-holding step.
Use an ephemeral GitHub-hosted runner. Shared or persistent self-hosted runners
are outside the supported threat model.

Repositories needing private registries or additional credentials must arrange
those outside depvisor. Adding such credentials to the agent environment expands
its authority and is not a depvisor input.

## Dependency-state boundary

Before model work, depvisor snapshots:

- every current and previous path in the updater PR diff; and
- recognized dependency manifests, lockfiles, catalogs, and project files found
  in the checkout.

The same snapshot is checked after the agent and immediately before publication.
A changed, added, removed, or retargeted frozen path yields
`dependency-state-changed`; no repair or report is published. This preserves the
updater's ownership without reintroducing v1 package-manager logic.

The publication handoff also rejects repairs exceeding 200 files or 5 MiB of
binary patch/new-file content.

PR patch text supplied to the agent is independently capped at 16,000 characters
per file and 180,000 characters per run. Failed workflow jobs are paginated up
to 3,000 jobs, while downloaded log tails share a 180,000-character run budget.
