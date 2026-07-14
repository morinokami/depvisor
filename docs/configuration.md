# Configuration

depvisor v2 reads `.github/depvisor.yml` from the immutable PR base-tip SHA via
the GitHub API. The PR head and working tree are never trusted for configuration.
A missing/oversized file, invalid YAML, unknown key at any schema level, blank or
oversized command, or version other than `2` is `bad-config`; no target command
or LLM starts.

## Schema

```yaml
version: 2

repair:
  enabled: true
  update_types: [patch, minor, major, digest]

verification:
  prepare: []
  commands:
    - ./script/ci

updaters:
  dependabot:
    enabled: true
  renovate:
    enabled: true
    trusted_actors:
      - renovate[bot]
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

### `repair`

- `enabled` is required.
- `update_types` defaults to patch/minor/major/digest. Allowed values are
  `patch`, `minor`, `major`, `digest`, and `unknown`.
- Repair remains PR-level all-or-nothing: every normalized change must be
  `repair-safe`, the branch must be in-repository, and the updater merge base
  must equal the current base tip.
- `enabled: false` is real read-only mode, not a dry run.

### `verification`

- `prepare` defaults to empty and runs before checks in each clean job.
- `commands` defaults to empty. When repair is enabled/selected, an empty list is
  `verification-unavailable`; reviewer policy remains independent.
- Commands are shell commands in order. There is no JS auto-detection and no
  workflow input override.
- Base and head failures receive one clean confirmation. Disagreement is
  `verification-unstable`. Candidate failure can be confirmed for reporting but
  can never be retried into acceptance.

### `updaters`

- Dependabot is trusted only as the exact GitHub Bot actor/commit identity.
- Renovate defaults to `renovate[bot]`; self-hosted installations must list the
  exact trusted Bot/App actor or dedicated service-user login. An ordinary user
  is never inferred from a branch prefix.
- `rebase_label` is optional. If present, the publisher may add exactly that
  trusted-base label to request regeneration. Without it, Renovate refresh is a
  manual retry-checkbox handoff.
- Titles, labels, branch names, and PR-body metadata never attest a provider.

### `report`

- `enabled` and `update_types` independently select read-only review.
- Include `unknown` when generic reviews of unclassified ecosystems should spend
  a reviewer call. Restrictive selectors intentionally skip unknown types.
- `language` is a bounded BCP-47-style tag and defaults to `en`.
- `suggest_features` is retained as report policy; depvisor never edits code to
  adopt optional upstream features.

### `cost`

- `max_dependencies_per_pr` defaults to 20 (range 1–100).
- `max_llm_calls_per_pr` defaults to 2 (range 0–2). Reviewer selection consumes
  one call before fixer selection, so a limit of 1 with both selected produces
  review-only behavior.
- Cross-PR daily/weekly budgets need shared coordinator state and are not
  implemented by the stateless reusable workflow.

## Invocation inputs and secrets

Inputs: `workflow_run_id`, manual `pr_number`, `llm_model`, and
`llm_api_key_env`.

The called workflow checks out depvisor from its own immutable workflow SHA.
There is no separate source-ref input that can drift from the ref selected by the
caller's `jobs.<id>.uses` declaration.

Secrets are explicit: `llm_api_key`, `publisher_app_client_id`,
`publisher_private_key`, and optional PAT fallback `publisher_token`. Never use
`secrets: inherit`.

The v1 inputs (`dry_run`, `conflict_refresh_only`, `verify_commands`,
`open_pull_requests_limit`, `minimum_release_age`, `ignore`, `groups`,
`base_branch`, `install_command`, and `github_token`) do not exist in v2.
