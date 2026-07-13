# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

depvisor prepares Dependabot-style dependency-update PRs, shipped as a GitHub **composite action** (`action.yml`). It does what a human does to such a PR — apply the update, fix whatever it breaks, verify, and open the PR — but splits the work by trust: the dependency bump, install, and **all** verification are **deterministic**, and an LLM is used only for the two jobs that need judgment — fixing source breakage when the deterministic checks fail (the **fixer**), and writing the PR's reviewer digest (the **digest**). Keep `README.md` and the user-facing reference pages in `docs/` (`configuration.md`, `results.md`) in sync when behavior changes — and `start.md` too: it is the agent-facing setup guide the README tells AI coding agents to fetch (by raw URL, so it must stay self-contained), and it duplicates the consumer workflow template, input names, and status names on purpose.

**Whenever you change code, check whether the affected docs are still accurate — this file (commands, invariants, gotchas) AND whichever entry in the "detail lives next to what it describes" table below owns the detail you touched — and update them in the same change if not.** Keep this file lean: it is loaded into every session, so a line Claude could learn by reading the code costs more than it is worth. Module-level detail belongs in that module's doc header; flow and release detail belong in the skills listed below.

## Commands

depvisor itself uses **pnpm** (the default fixture is an npm project; a pnpm variant exists). Node >= 24 required (declared in package.json `engines`; stricter than Flue's own >= 22.19 floor, and CI verifies 24 only).

```bash
pnpm test                                    # unit tests (node --test), no API key
node --test test/grouping.test.ts            # single test file
pnpm run check                               # all CI gates in one: typecheck + lint + fmt:check + knip + test
zizmor --persona=auditor --min-confidence=high .
                                             # GitHub Actions/composite-action security gate
node src/dev/scan.ts fixtures/sample-app --verify   # deterministic core E2E, no API key (CI's fixture-e2e job runs this per variant)
pnpm run fixture:init                        # create the throwaway fixture (required before agent runs)
pnpm run fixture:init:pnpm                   # pnpm variant → fixtures/sample-app-pnpm (tests PM detection)
pnpm run fixture:init:bun                    # bun variant → fixtures/sample-app-bun (needs a local bun)
pnpm run fixture:init:workspaces             # npm-workspaces monorepo → fixtures/sample-app-workspaces
pnpm run fixture:init:workspaces:bun         # bun-workspaces monorepo → fixtures/sample-app-bun-workspaces
pnpm run fixture:init:workspaces:pnpm        # pnpm-workspaces monorepo (catalog-pinned semver) → fixtures/sample-app-pnpm-workspaces
pnpm exec flue run update                    # agent run; needs API key + DEPVISOR_LLM_MODEL in .env (DEPVISOR_OPEN_PULL_REQUESTS_LIMIT optional)
node src/open-pr.ts                          # push + PR from every emitted payload; needs GH_TOKEN + remote
cd fixtures/sample-app && git checkout -f main && npm install        # reset fixture to green baseline
```

Fixture agent run (scans and picks groups itself, same path as CI):
`DEPVISOR_TARGET_REPO="$PWD/fixtures/sample-app" pnpm exec flue run update`
(add `DEPVISOR_OPEN_PULL_REQUESTS_LIMIT=1` to cap the run at a single PR; the default ceiling is 5)

## Architecture

One split governs everything: **deterministic code does anything needing reproducibility, idempotency, or safety — the dependency bump, the install, and all verification; an LLM does only the two jobs that need judgment — fixing source breakage when the deterministic checks fail (the fixer), and writing the PR digest — each boxed between deterministic gates.**

`src/core/` is the deterministic, LLM-free, unit-tested half. `src/agents/` (+ `fixer.md` / `digest.md`) and `src/workflows/update.ts` + its nested support modules are the only LLM-driven code — `src/tools/` and `flue.config.ts` touch Flue APIs but stay LLM-free. Detail lives next to what it describes:

| Where                        | What it covers                                                               |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `src/core/CLAUDE.md`         | the core pipeline, per-module failure policy, shared leaves, exit boundaries |
| `src/CLAUDE.md`              | the agent capability boundary, the entrypoint/token map                      |
| each module's file header    | that module's rationale — **write module detail there, not here**            |
| `depvisor-update-flow` skill | the per-group loop, its gates, the status vocabulary                         |
| `depvisor-release` skill     | `action.yml`, the dev workflow, release-please, commit-type convention       |

## Invariants

Preserve these when changing the update flow (see the `depvisor-update-flow` skill). These are the lines that, if removed, would let a change quietly break the trust model.

- **Token separation is structural, not instruction-based**: the agent step holds only the LLM key; GitHub tokens exist only in the snapshot and open-pr steps, with `persist-credentials: false` on checkout. Never hand the agent step a token or let the agent run git/GitHub operations.
  - The deterministic bump (`bump.ts`) and the multi-PR loop's group-boundary reinstall (`runInstall`) both run the target's lifecycle scripts inside the token-free agent step. This adds **no new exposure class**: install scripts already run there (the pre-agent install and the between-groups reinstall), and no GitHub token is ever present in that step.
  - **Agent host isolation is capability-based**: the root uses Flue's in-memory virtual sandbox, so built-in fs/shell cannot reach the runner. `repo-files.ts` is the only host bridge; digest receives read/list/search only, fixer additionally receives bounded repo-relative write/replace/remove, and `.git`/symlink/`..` escapes are rejected. Neither role can rewrite depvisor's own checkout or the source the later GH_TOKEN step executes. Do not reintroduce `local()` or a host shell tool without restoring an OS-level isolation boundary first.
  - The user's checkout can defeat the separation from outside (actions/checkout defaults to `persist-credentials: true`), so `core/credentials.ts` fail-closes on persisted credentials in the checkout's repo-**local** git config (the vectors it checks are enumerated in that module). Enforced twice — the `check-credentials.ts` Action step, and the `persisted-credentials` preflight status covering local/non-action runs. Best-effort over known vectors, not a guarantee.
- **Commit identity is split on purpose** (`git.ts:commitStaged`, where the full rationale lives): the **author** is a resolvable `github-actions[bot]` address — display-only, because Vercel-class integrations refuse to build a PR whose author resolves to no GitHub account (#46) — while the **committer** stays the unclaimable `depvisor[bot]` sentinel (`AGENT_EMAIL`), and both push-boundary guards in `github.ts` key on the committer (`%ce`), never the author: a human rebase/amend/web-UI edit always rewrites the committer (exactly the takeover signal), while the author is trivially forged via `--author`. Never move a guard onto the author and never make the committer configurable (a configurable _author_ would be safe, but is deliberately deferred until someone asks). These guards were never cryptographic — the sha-based gates are the hard ones.
- **The mechanical bump commit is made before any LLM runs** (`workflows/update/process-group.ts`): `deps: bump <pkgs>` is committed by deterministic code the moment the bump applies, so a reviewer is structurally guaranteed the AI wrote none of it; the `fix: adapt code to <pkgs>` commit exists only when the fixer adapted source. Install/verification leftovers never fold into it: clean-tree/worktree-drift gates reject them. Never let an agent create either commit.
- **Branch name = stable group key = PR identity**: changing grouping or naming logic changes PR identity and breaks idempotency/skip-if-up-to-date. A user-declared `groups` key (`group/<name>`) derives from the declared name alone — never from which members are present in a run — so membership drift (cooldown maturation, `ignore`) refreshes the same PR instead of forging a new identity.
  - The `minimum_release_age` clamp is a **known, documented exception**: a clamped candidate's `updateType` is recomputed, so a cooldown-window major can surface first as e.g. `prod/<name>` and later, once matured, move to `major/<name>` — a different branch and a new PR. The stranded earlier PR is not auto-closed and keeps occupying a `open_pull_requests_limit` slot until a human closes/merges it (`docs/configuration.md` documents this; a superseded-PR closer is a recorded future feature, not present).
  - **Security prioritization (`advisories.ts`) is ordering ONLY, so it is NOT an identity exception**: it reorders groups but never touches keys, membership, or the installed version. Keep it that way — a "promote by editing the group key" shortcut would break idempotency.
- **Package-manager detection is pinned at preflight** (`core/pm.ts`, called once from `core/preflight.ts` against the trusted base tree; also by `install-target.ts` and `dev/scan.ts`).
  - Supported: npm + pnpm + bun; yarn and ambiguous lockfile mixes fail closed (`unsupported-package-manager` / `ambiguous-package-manager`, no agent run). bun repos need the bun binary on the runner (`oven-sh/setup-bun`, version pinned — see `docs/configuration.md`).
  - Never re-detect after the agent has run — lockfiles are agent-writable, so post-agent detection would let the agent switch which commands the trusted steps execute.
  - The detected `pm` drives everything downstream: collect, verify `run` prefixes, the deterministic bump plan (`pm.updatePlan`, executed by `bump.ts`), the group-boundary reinstall, and the bump commit's lockfile set. The per-PM mechanics — workspace scoping, `pinExact` under the cooldown, pnpm's catalog YAML edit and workspace enumeration — live in the `pm.ts`/`pm-pnpm.ts`/`bump.ts`/`collect.ts` headers and `src/core/CLAUDE.md`.
- **Two scope gates guard the diff (`core/scope.ts`), both fail-closed gates over a git diff.** The allow/deny mechanics (the whole-string value grammar, the catalog keying, the untracked-files handling) are documented in `scope.ts` itself; what must not change is the shape:
  - `checkBumpScope` diffs the working tree against the IMMUTABLE pre-bump sha (never a movable ref name — the lifecycle scripts it defends against can move refs) **before the mechanical bump is committed**, and ALLOW-lists only the plan's own writes. It exists to catch a poisoned install lifecycle script whose edits would otherwise ride along in the "mechanical" commit, invisible to the fixer gate.
  - `checkFixScope` checks everything the fixer changed relative to the **bump commit** and denies ALL dependency state — every `DENY`-list path, any `package.json`, every PM lockfile, `pnpm-workspace.yaml` — because the deterministic bump already owns every legitimate dependency change. Extend `DENY` by hand for any new config/execution surface, and mirror path additions in `agents/fixer.md` so the fixer avoids them instead of burning a run on a scope violation.
  - **Tests are the one surface the scope gate cannot deny** (adapting a test to a changed API is a legitimate update); `core/test-changes.ts` handles them by _visibility_ instead. Do not add a deny for tests.
- **The verification gate refusing to vouch (`no-verify-scripts`) means no PR**, by design.
  - Verify steps come from script auto-detection (`build`/`lint`/`test` — `typecheck` deliberately not detected), or from the `verify_commands` input (`DEPVISOR_VERIFY_COMMANDS`, newline-separated shell commands), which **replaces** auto-detection entirely.
  - `verify_commands` must only ever come from the workflow file/env, never from the agent-writable target tree.
  - The same gate also runs on the base tip **before the agent, once per processed group** (`baseline-red` on the first — base itself is broken; `reset-failed` on a later group — the between-groups reset was incomplete). Either is a fail-closed run-level stop, so post-update failures are always attributable to that group's update. The reset/reinstall mechanics are in the `depvisor-update-flow` skill.
- **`.git/` is outside the scope gate (it only sees the working tree), so target install/verification scripts are treated as able to write it. Agent repo tools reject `.git` entirely.**
  - Every git invocation disables local hooks (`NO_HOOKS = -c core.hooksPath=/dev/null`, exported from `git.ts`, reused in `github.ts`). Never add a git call that bypasses `run()`/the `git()` wrapper.
  - **Ref integrity is snapshot-verified around every untrusted target execution** (`core/ref-guard.ts`, over `git.ts`'s snapshot/diff/restore leaves): group-boundary reinstall, baseline verification, bump lifecycle scripts, and both post-bump/post-fix verification phases run target code with `.git` reachable. Each group captures a `RefGuard` before the first such execution, records expected refs across trusted branch/commit writes, and checks every boundary including failures. The fixer/digest cannot reach `.git`; the post-digest seal remains defense in depth for delayed target processes.
  - The token-holding open-pr step runs entirely inside a fresh clone (`prepareCleanPush` in `github.ts`), because `.git/config` alone is a rich command-execution surface (`credential.helper=!cmd` fires on push auth, plus `core.fsmonitor`, `diff.external`, `filter.*`, …) that hook-disabling does not cover. Do not make the open-pr step operate on the target checkout's `.git`.
  - The push **target** is equally untrusted: in CI it comes from `DEPVISOR_REMOTE_URL` (Actions context `${server_url}/${repository}`); only when that is unset (local dev on a trusted machine) does it fall back to the checkout's `remote.origin.url` — the one read the open-pr step performs against the target checkout's `.git`. Either way it must pass `isNetworkRemote` — a push to a local/`file:`/helper remote would run that remote's server-side hooks in this `GH_TOKEN` process.
  - The payload's **`title`/`body` are untrusted at this boundary too** (written by the tokenless step): `openPrWithGh` re-sanitizes them at the exit (`sanitizePrBody`, preserving only the strictly-validated **trailing** versions marker — why it must be end-anchored is documented at `pr.ts:extractVersionsMarker`), just as it re-validates `base` and the branch's committers.
  - The **inherited target-script environment** is untrusted too: lifecycle/verification scripts can write `$HOME/.gitconfig` or inject through runner files. All git/gh in `github.ts` therefore run via `buildSecureEnv` (token env allowlist only, clean HOME/XDG/GH config dir, `GIT_CONFIG_NOSYSTEM=1`, no inherited `GIT_*`/loader/exec env, PATH pinned, binaries by absolute path). Keep every subprocess in this module on that env.
- **Keep the Flue dependency thin**: `defineAgent` / `defineWorkflow` / `defineTool` / `defineAgentProfile` / the default virtual sandbox / `harness.session(name)` / `session.task` (structured result + named subagent + response usage/model/data) / workflow `log` / `ResultUnavailableError` / `FlueError`, exact-pinned beta. `session.prompt` and `local()` are not used.
  - `defineTool` is used for release notes and the profile-separated bounded repo bridge; `defineAgentProfile` + `session.task({ agent })` for fixer/digest; `FlueError` for digest fail-soft. Keep the rest thin so the AI-SDK escape hatch stays open.
  - All are "Flue lets you not write it" rather than "only Flue can express it," so portability is preserved.

## Gotchas

- Env config treats **empty strings as "not set"** everywhere (`||`/falsy checks, never `??`): the composite action forwards unset inputs as empty strings. Every config knob follows the fail-closed parse shape in `src/core/CLAUDE.md`; each knob's default and `bad-*` status are documented in its parser's header. The one exception: `DEPVISOR_LLM_MODEL` has **no user-facing default** — normal runs fail fast when it is unset/empty. Flue initializes the root harness before the workflow can branch and rejects unknown model IDs, so the credential-free `dry_run` path uses a real catalog model-shaped sentinel but ignores the configured model and deletes the built-in providers' API keys Flue may have loaded from a project-root `.env`; it never opens a model session, and an accidental one fails closed without credentials.
- `npm outdated` / `pnpm outdated` read the **installed tree** — without an install in the fixture, candidates are hidden — and both exit 1 when updates exist (JSON still on stdout). `bun outdated` reads the **committed lockfile** instead (works without an install, errors without a lockfile), always exits 0, and prints an ASCII table, not JSON. The parser rationale — npm's error-object shape failing closed, per-PM workspace merging, bun's `FORCE_COLOR` quirk — lives in `collect.ts`.
- `fixtures/sample-app*` are gitignored throwaway git repos generated from the committed `*.template/` directories; `sample-app.template/` deliberately contains code that the lru-cache major update breaks (the fixer's raison d'être). The workspace variants are two-package monorepos sharing `semver` (catalog-pinned in the pnpm one, so it exercises the deterministic catalog edit end to end). Per-variant quirks — the pnpm workspace-capture guard, which variant generates its lockfile when, per-PM template differences — are documented in `scripts/init-fixture.sh`.
- No build step: everything except the discovered agent/workflow entrypoints runs directly under plain Node with explicit `.ts` import extensions; tsconfig is maximally strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). `agents/depvisor.ts` is the one exception (Flue-bundler-only `.md` imports); nested `agents/` / `workflows/` support modules are ordinary, plain-node-safe modules — the full split is in `src/CLAUDE.md`.
- For Flue API questions, use the `flue` skill (`flue docs search/read`) rather than guessing — the dependency is a beta.
