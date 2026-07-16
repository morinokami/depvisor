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

## Releases

release-please remains manifest-mode. Merging its Release PR creates immutable
`vX.Y.Z`; `tag-major` moves the released major/minor tags. Consumer docs now use
`@v2`, so the first v2 release must be `2.0.0` and movable `v2`/`v2.0` will follow
automatically from release-please outputs. Do not move `v1`; it remains the old
updater line.

This rewrite is a breaking release. Its squash/merge commit must use a breaking
Conventional Commit (`feat!:` or a `BREAKING CHANGE:` footer), or an explicit
`Release-As: 2.0.0`, so release-please does not cut a v1 minor.

## Dependency bump commit types

- No observable behavior: `chore(deps):` or `build(deps):` (no release).
- Bundled security fix: `fix(deps):`.
- Observable behavior: `fix:` / `feat:` describing the behavior.
