---
name: depvisor-release
description: Use when touching depvisor's own CI or distribution plumbing — action.yml, the development workflow .github/workflows/depvisor.yml, .github/workflows/release.yml, release-please config, the movable v1 tags — or when choosing the Conventional Commit type for a dependency bump so it releases (or stays silent) correctly.
---

# depvisor's own CI and distribution

Both workflows below touch no target checkout beyond what the composite action already does, run no agent of their own, and leave the token-separation / fresh-clone / scope-gate invariants in the repo-root `CLAUDE.md` untouched.

## The composite action (`action.yml`)

The Action parses all behavior inputs through `check-config.ts` after installing
depvisor itself but before installing the target. Its canonical `dry_run` output
drives both credential omission from the Flue step and structural skipping of
the push/open-PR step; do not branch on the raw, whitespace-tolerant input.

Two documented GitHub-runner quirks — **read the comments in `action.yml` before touching it**:

1. A nested `uses:` does not evaluate `github.action_path`.
2. `pnpm/action-setup` breaks on absolute paths.

The second quirk is **load-bearing on purpose**: `pnpm/action-setup` reads `packageManager` from `package_json_file` (default = the _target_ checkout's `package.json`) and refuses when it differs from the pinned `version` (#35). So `package_json_file` is pointed at depvisor's own manifest — the absolute path mangles to a nonexistent file, the target's `packageManager` is never read, and the pinned `version` stands.

One platform caveat worth remembering: nesting the action inside another composite loses step outputs (actions/runner#2009, documented in docs/results.md).

## The development workflow (`.github/workflows/depvisor.yml`)

It runs the composite action from the checkout via `uses: ./`, matching a consumer workflow except for that `uses: ./` and `install_command: skip` — the target is depvisor itself, a pnpm repo, and the action's own `pnpm install` covers it.

The separate `fixture-e2e` matrix in `.github/workflows/ci.yml` runs both the
plain deterministic scanner and the real Flue workflow's credential-free
dry-run path for every npm/pnpm/bun fixture variant. Keep the latter free of
model credentials and assert its emitted plan/status plus clean target state.

## The release workflow (`.github/workflows/release.yml`)

**release-please** (manifest mode, `release-type: node`, config in `release-please-config.json` + `.release-please-manifest.json`) reads Conventional Commits on `main` and keeps one **Release PR** open that computes the next version, regenerates `CHANGELOG.md`, and bumps `package.json` `version`.

**Merging that Release PR** is the human gate that cuts the `vX.Y.Z` tag + GitHub Release. The second job (`tag-major`, hand-carved shell) then force-moves the movable `v1` / `v1.x` tags to the released commit so `morinokami/depvisor@v1` in the README keeps resolving.

- Third-party actions are **SHA-pinned** (`ci.yml` family style).
- depvisor's runtime code never reads its own `package.json` `version`, so a bump is distribution-only — no behavior change. **Keep it that way.**
- `bootstrap-sha` pins release-please's scan start to the setup commit so it does not fold the whole `feat`/`fix` history into the first CHANGELOG; the first release was forced to `1.0.0` via a one-shot `Release-As: 1.0.0` commit footer on `main`.
- Do **not** add the README's `@v1` to `extra-files` — the movable pin must stay `@v1` for all of v1.x.
- A future `release: published` publish workflow (Marketplace) would not fire from a `GITHUB_TOKEN`-created release (GitHub's recursion guard); switch release-please to a PAT / GitHub App token then. Recorded, not needed today.

## Dependency-update commit-type convention

release-please reads the squash subject on `main`, and the repo is set to "squash message = PR title".

- A dependency bump depvisor absorbs with **no observable behavior change** is `chore(deps):` / `build(deps):` — silent (hidden in `changelog-sections`, drives no release).
- A **security fix** in a bundled dependency is `fix(deps):`. A consumer runs depvisor's bundled deps on their runner, so a CVE fix changes their attack surface; `chore(deps):` would leave it unshipped.
- A bump whose behavior **leaks through** is `fix:` / `feat:` **described by the behavior**, not "bump X".

**Footgun**: depvisor's own PRs are titled `deps: update …` (`pr.ts`), which is silent by design — so a security update needs the merger to **retype the squash subject to `fix(deps):`**, or it never releases.
