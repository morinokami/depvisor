---
name: depvisor-release
description: Use when touching depvisor's composite action, development/CI/release workflows, release-please config, movable v2 tags, or dependency-bump Conventional Commit type.
---

# depvisor v2 CI and distribution

## Composite action

`action.yml` keeps the minimum `with:` surface at `llm_api_key` and `llm_model`.
Optional inputs are only provider-env override, GitHub token override, and Node
version. PR/run identifiers always come from GitHub context.

Order is load-bearing:

1. resolve the action/run-temp paths;
2. set up depvisor's pinned pnpm and Node;
3. reject checkout-persisted credentials;
4. install depvisor;
5. token-holding read-only PR/CI snapshot;
6. snapshot depvisor's publisher source;
7. local-sandbox agent with model key and no GitHub token;
8. scrub loader/shell env, verify source integrity, then run token-holding
   fresh-clone publication when a payload exists; these are file/environment
   checks, not protection from a same-UID residual process or writable toolchain;
9. always verify source again and report status/outputs.

Keep the two runner workarounds documented in action.yml: nested `uses:` cannot
evaluate `github.action_path`, and pnpm/action-setup's absolute
`package_json_file` handling intentionally avoids reading the target manifest.

## Development workflow

`.github/workflows/depvisor.yml` is a real `workflow_run` consumer of `CI`. It
checks out the triggering head SHA and grants only `actions: read`,
`contents: write`, and `pull-requests: write`. The v2 agent needs open network
research/install access, so harden-runner is audit-mode there rather than a fixed
allowlist.

`.github/workflows/ci.yml` runs the ordinary `pnpm run check` gate and the
actionlint/zizmor job. There is no fixture matrix: v2 has no package-manager
implementation or credential-free dry-run.

`.github/workflows/self-check.yml` is the weekly cron (plus manual dispatch)
that reads the last week of depvisor runs and files at most two
`self-check`-labeled issues. It repeats the action's token split in miniature:
`self-check-collect.ts` (GH_TOKEN, `actions: read`) builds a bounded envelope,
`flue run workflow:self-check` (qualified: the agent and workflow share the
name) analyzes it with the model key, no GitHub token, and no sandbox, and
`self-check-report.ts` (GH_TOKEN, `issues: write`) re-validates the handoff —
all cited run ids must resolve, agent-authored links and raw HTML render
inert — before creating issues. An empty findings list is the designed
healthy outcome, so a quiet week must not fail the job. Its harden-runner
allowlist is block-mode and includes `*.blob.core.windows.net` (job-log
archive redirects) and `api.openai.com` (analyst model). knip's
`github-actions` plugin is disabled in knip.json so these workflow-invoked
entrypoints stay explicitly listed and strict mode agrees with normal mode.

`.github/dependabot.yml` updates GitHub Actions and npm weekly with a 7-day
cooldown, pairing with pnpm-workspace.yaml's strict `minimumReleaseAge`.
`@flue/*` is ignored there: Flue stays exact-pinned beta and is upgraded
deliberately.

## Releases

release-please remains manifest-mode. Merging its Release PR creates immutable
`vX.Y.Z`; `tag-major` moves the released major/minor tags. Do not move `v1`; it
remains the old updater line.

## Dependency bump commit types

- No observable behavior: `chore(deps):` or `build(deps):` (no release).
- Bundled security fix: `fix(deps):`.
- Observable behavior: `fix:` / `feat:` describing the behavior.
- The bare `deps:` type is a pre-v2 legacy that survives in old history; do not
  use it in new commits.
