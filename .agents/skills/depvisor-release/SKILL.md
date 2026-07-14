---
name: depvisor-release
description: Use when touching depvisor's reusable workflow, CI/release workflows, release-please configuration, movable major/minor tags, or dependency commit release semantics.
---

# depvisor v2 CI and distribution

## Public reusable workflow

`.github/workflows/depvisor.yml` is the v2 interface; `action.yml` no longer
exists. Preserve explicit `workflow_call` inputs/secrets, SHA-pinned Actions,
`persist-credentials: false`, typed bounded artifacts, and job isolation:
target code, LLM credentials, and the App/PAT write credential never share a job.
The publisher must remain a fresh-clone normal-push boundary.

Consumer examples use the movable `v2` tag by default. Every job checks out
depvisor with `job.workflow_repository` at `job.workflow_sha`, so runtime source
is always the exact commit GitHub selected for the called workflow. Never add a
separate source-ref input. Consumer setup lives in README and the self-contained
`start.md`; update both with interface changes.

## CI

`.github/workflows/ci.yml` runs every code-quality/unit gate and Action security
audit. Fixtures are immutable base/head PR pairs, not updater discovery repos.

## Release

Release Please remains manifest-mode (`release-type: node`). Merging its Release
PR creates immutable `vX.Y.Z`; the second job dynamically moves the released
`vX` and `vX.Y` tags. Thus v2 releases advance `v2`/`v2.0` while the existing
v1 tags remain on the final v1 release line.

Third-party Actions stay SHA-pinned. Runtime code must not depend on the package
version. Do not add movable documentation pins to release-please extra files.

## Dependency commit types

- No observable behavior: `chore(deps):` or `build(deps):` (no release).
- Bundled security fix: `fix(deps):`.
- Behavior leak: `fix:` or `feat:` described by behavior.

The breaking v2 merge must use a breaking Conventional Commit (`feat!:` or a
`BREAKING CHANGE:` footer) so release-please proposes 2.0.0.
