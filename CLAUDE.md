# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

depvisor is **aftercare for dependency-update PRs**, shipped as a GitHub **composite action** (`action.yml`). Dependabot/Renovate-class updaters own discovery, version selection, dependency-state edits, and the PR lifecycle; depvisor consumes their PRs and does what still falls to a human — understand the change in this repository's context, explain upstream changes and risks, repair source/tests when the update breaks deterministic verification, prove the repair, and publish a bounded repair commit plus an evidence-grounded reviewer report comment. The work splits by trust: the dependency diff, install, and **all** verification are **deterministic**; an LLM is used only for the two jobs that need judgment — fixing source breakage when the checks fail (the **fixer**), and writing the report (the **digest**). Keep `README.md` and the user-facing reference pages in `docs/` (`configuration.md`, `results.md`) in sync when behavior changes — and `start.md` too: it is the agent-facing setup guide the README tells AI coding agents to fetch (by raw URL, so it must stay self-contained), and it duplicates the consumer workflow template, input names, and status names on purpose.

**Whenever you change code, check whether the affected docs are still accurate — this file (commands, invariants, gotchas) AND whichever entry in the "detail lives next to what it describes" table below owns the detail you touched — and update them in the same change if not.** Keep this file lean: it is loaded into every session, so a line Claude could learn by reading the code costs more than it is worth. Module-level detail belongs in that module's doc header; flow and release detail belong in the skills listed below.

## Commands

depvisor itself uses **pnpm** (the default fixture is an npm project; a pnpm variant exists). Node >= 24 required (declared in package.json `engines`; stricter than Flue's own >= 22.19 floor, and CI verifies 24 only).

```bash
pnpm test                                    # unit tests (node --test), no API key
node --test test/dep-diff.test.ts            # single test file
pnpm run check                               # all CI gates in one: typecheck + lint + fmt:check + knip + test
actionlint                                   # GitHub Actions workflow semantics + embedded shell checks
zizmor --persona=auditor --min-confidence=high .
                                             # GitHub Actions/composite-action security gate
node src/dev/scan.ts fixtures/sample-app --base=main --verify=broken --expect-changes=lru-cache
                                             # deterministic core E2E, no API key (CI's fixture-e2e job runs this per variant)
pnpm run fixture:init                        # create the throwaway fixture (required before agent runs)
pnpm run fixture:init:pnpm                   # pnpm variant → fixtures/sample-app-pnpm (tests PM detection)
pnpm run fixture:init:bun                    # bun variant → fixtures/sample-app-bun (needs a local bun)
pnpm run fixture:init:workspaces             # npm-workspaces monorepo → fixtures/sample-app-workspaces
pnpm run fixture:init:workspaces:bun         # bun-workspaces monorepo → fixtures/sample-app-bun-workspaces
pnpm run fixture:init:workspaces:pnpm        # pnpm-workspaces monorepo (catalog-pinned semver) → fixtures/sample-app-pnpm-workspaces
pnpm exec flue run aftercare                 # agent run against the fixture's updater branch; needs API key + DEPVISOR_LLM_MODEL in .env (+ DEPVISOR_BASE_REF=main)
node src/publish.ts                          # push repair + report comment from the emitted payload; needs GH_TOKEN + remote + DEPVISOR_PR_NUMBER/DEPVISOR_HEAD_REF
cd fixtures/sample-app && git checkout -f update/lru-cache && npm install   # reset fixture to the updater-branch state
```

Fixture agent run (analyzes the checked-out updater branch, same path as CI):
`DEPVISOR_TARGET_REPO="$PWD/fixtures/sample-app" DEPVISOR_BASE_REF=main pnpm exec flue run aftercare`

## Architecture

One split governs everything: **deterministic code does anything needing reproducibility, idempotency, or safety — the dependency diff, the installs, and all verification; an LLM does only the two jobs that need judgment — repairing source breakage when the deterministic checks fail (the fixer), and writing the reviewer report (the digest) — each boxed between deterministic gates.**

`src/core/` is the deterministic, LLM-free, unit-tested half. `src/agents/` (+ `fixer.md` / `digest.md`) and `src/workflows/aftercare.ts` + its nested support module are the only LLM-driven code — `src/tools/` and `flue.config.ts` touch Flue APIs but stay LLM-free. Detail lives next to what it describes:

| Where                           | What it covers                                                               |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `src/core/CLAUDE.md`            | the core pipeline, per-module failure policy, shared leaves, exit boundaries |
| `src/CLAUDE.md`                 | the agent capability boundary, the entrypoint/token map                      |
| each module's file header       | that module's rationale — **write module detail there, not here**            |
| `depvisor-aftercare-flow` skill | the per-PR gate sequence, attribution, the status vocabulary                 |
| `depvisor-release` skill        | `action.yml`, the dev workflow, release-please, commit-type convention       |

## Invariants

Preserve these when changing the aftercare flow (see the `depvisor-aftercare-flow` skill). These are the lines that, if removed, would let a change quietly break the trust model.

- **Token separation is structural, not instruction-based**: the agent step holds only the LLM key; the GitHub token exists only in the publish step, with `persist-credentials: false` on checkout. Never hand the agent step a token or let the agent run git/GitHub operations.
  - **Agent host isolation is capability-based**: the root uses Flue's in-memory virtual sandbox, so built-in fs/shell cannot reach the runner. `repo-files.ts` is the only host bridge; digest receives read/list/search only, fixer additionally receives bounded repo-relative write/replace/remove, and `.git`/symlink/`..` escapes are rejected. Neither role can rewrite depvisor's own checkout or the source the later GH_TOKEN step executes. Do not reintroduce `local()` or a host shell tool without restoring an OS-level isolation boundary first.
  - The user's checkout can defeat the separation from outside (actions/checkout defaults to `persist-credentials: true`), so `core/credentials.ts` fail-closes on persisted credentials in the checkout's repo-**local** git config (the vectors it checks are enumerated in that module). Enforced twice — the `check-credentials.ts` Action step, and the `persisted-credentials` preflight status covering local/non-action runs. Best-effort over known vectors, not a guarantee.
- **The updater owns ALL dependency state; the fixer owns none.** `scope.ts` is that rule's single source: `isDependencyStatePath` (manifests, every known PM lockfile, pnpm-workspace.yaml) names what an updater commit may touch, and `checkFixScope`/`repairScopeViolations` deny exactly that set plus every execution-surface config path (`DENY`) to the repair. Extend `DENY` by hand for any new config/execution surface, and mirror path additions in `agents/fixer.md` so the fixer avoids them instead of burning a run on a scope violation. **Tests are the one surface the scope gate cannot deny** (adapting a test to a changed API is a legitimate repair); `core/test-changes.ts` handles them by _visibility_ instead. Do not add a deny for tests.
- **A repair must be attributable before it exists**: the fixer runs only after the PR head verified RED and its merge base verified GREEN under its own reinstalled lockfile state (`baseline-red` is a fail-closed stop, never a degrade). A PR carrying any non-depvisor commit that touches non-dependency paths is skipped green (`not-an-update-pr`, judged per commit in `dep-diff.ts:classifyPrCommits`) — depvisor never builds repairs on human work.
- **Commit identity is split on purpose** (`git.ts:commitStaged`, where the full rationale lives): the **author** is a resolvable `github-actions[bot]` address — display-only, because Vercel-class integrations refuse to build a PR whose author resolves to no GitHub account (#46) — while the **committer** stays the unclaimable `depvisor[bot]` sentinel (`AGENT_EMAIL`). Everything keys on the committer (`%ce`), never the author: `classifyPrCommits` recognizes depvisor's own previous repairs by it, and the publish boundary re-verifies every commit in the pushed range carries it — a human rebase/amend/web-UI edit always rewrites the committer (exactly the takeover signal), while the author is trivially forged via `--author`. Never move a guard onto the author and never make the committer configurable.
- **Publishing is compare-and-swap onto the updater's branch, never creation, never force**: the publish step (`github.ts:publishAftercare`) verifies the PR is still open on the trusted head ref, pushes the repair only when the remote tip still equals the exact head sha the run analyzed (a moved head is the green `publish-blocked`), and re-verifies the pushed range structurally at this exit boundary — descendant of the expected tip, sentinel committers only, `repairScopeViolations`-clean diff. The PR identity (`pr_number`/`head_ref`) comes from trusted action env; the payload is an untrusted read-back and must merely AGREE with it. `gh pr create`, PR title/body edits, and branch creation do not exist in v2 — do not reintroduce them.
- **Package-manager detection is pinned at preflight** (`core/pm.ts`, called once from `core/preflight.ts` against the checked-out head tree; also by `install-target.ts` and `dev/scan.ts`). Supported: npm + pnpm + bun; yarn and ambiguous lockfile mixes fail closed (`unsupported-package-manager` / `ambiguous-package-manager`, no agent run). bun repos need the bun binary on the runner. Never re-detect after the agent has run — lockfiles are agent-writable, so post-agent detection would let the agent switch which commands the trusted steps execute.
- **The verification gate refusing to vouch (`no-verify-scripts`) means nothing is published**, by design. Verify steps come from script auto-detection (`build`/`lint`/`test` — `typecheck` deliberately not detected), or from the `verify_commands` input (`DEPVISOR_VERIFY_COMMANDS`, newline-separated shell commands), which **replaces** auto-detection entirely. `verify_commands` must only ever come from the workflow file/env, never from the agent-writable target tree.
- **`.git/` is outside the scope gate (it only sees the working tree), so target install/verification scripts are treated as able to write it. Agent repo tools reject `.git` entirely.**
  - Every git invocation disables local hooks (`NO_HOOKS = -c core.hooksPath=/dev/null`, exported from `git.ts`, reused in `github.ts`). Never add a git call that bypasses `run()`/the `git()` wrapper.
  - **Ref integrity is snapshot-verified around every untrusted target execution** (`core/ref-guard.ts`, over `git.ts`'s snapshot/diff/restore leaves): head verification, the baseline install+verification, the head reinstall, and the post-repair verification all run target code with `.git` reachable. The run captures a `RefGuard` before the first such execution, records expected refs across trusted commit writes, and checks every boundary including failures. The fixer/digest cannot reach `.git`; the post-digest seal remains defense in depth for delayed target processes.
  - The token-holding publish step runs entirely inside a fresh clone (`publishAftercare` in `github.ts`), because `.git/config` alone is a rich command-execution surface (`credential.helper=!cmd` fires on push auth, plus `core.fsmonitor`, `diff.external`, `filter.*`, …) that hook-disabling does not cover. Do not make the publish step operate on the target checkout's `.git`.
  - The push **target** is equally untrusted: in CI it comes from `DEPVISOR_REMOTE_URL` (Actions context `${server_url}/${repository}`); only when that is unset (local dev on a trusted machine) does it fall back to the checkout's `remote.origin.url`. Either way it must pass `isNetworkRemote` — a push to a local/`file:`/helper remote would run that remote's server-side hooks in this `GH_TOKEN` process.
  - The payload's **`commentBody` is untrusted at this boundary too** (written by the tokenless step): the publish step re-sanitizes it at the exit (`sanitizeCommentBody`, preserving only the strictly-validated **trailing** aftercare marker — the comment-idempotency anchor).
  - The **inherited target-script environment** is untrusted too: lifecycle/verification scripts can write `$HOME/.gitconfig` or inject through runner files. All git/gh in `github.ts` therefore run via `buildSecureEnv` (token env allowlist only, clean HOME/XDG/GH config dir, `GIT_CONFIG_NOSYSTEM=1`, no inherited `GIT_*`/loader/exec env, PATH pinned, binaries by absolute path). Keep every subprocess in this module on that env.
- **Keep the Flue dependency thin**: `defineAgent` / `defineWorkflow` / `defineTool` / `defineAgentProfile` / the default virtual sandbox / `harness.session(name)` / `session.task` (structured result + named subagent + response usage/model/data) / workflow `log` / `ResultUnavailableError` / `FlueError`, exact-pinned beta. `session.prompt` and `local()` are not used. All are "Flue lets you not write it" rather than "only Flue can express it," so portability is preserved.

## Gotchas

- Env config treats **empty strings as "not set"** everywhere (`||`/falsy checks, never `??`): the composite action forwards unset inputs as empty strings. Every config knob follows the fail-closed parse shape in `src/core/CLAUDE.md`; each knob's default and `bad-*` status are documented in `core/config.ts`. `DEPVISOR_LLM_MODEL` has **no user-facing default** — runs fail fast when it is unset/empty (it is the agent factory's input, not a `RunConfig` field).
- The dependency diff (`core/dep-diff.ts`) is lockfile-resolved only when the lockfile parses (npm JSON v1–v3, pnpm YAML v6–v9 keys, textual `bun.lock`; the binary `bun.lockb` cannot be read) — otherwise it falls back to manifest specifiers, fail-soft, because it feeds display/prompt only; the security gates never depend on it. Lockfile-ONLY updates (Dependabot in-range refreshes) surface via the lockfile diff, so don't "optimize" the manifest-unchanged case away.
- `fixtures/sample-app*` are gitignored throwaway git repos generated from the committed `*.template/` directories; `sample-app.template/` deliberately contains code that the lru-cache major update breaks (the fixer's raison d'être). `scripts/init-fixture.sh` builds a green baseline on `main`, then an updater-style `update/lru-cache` branch (dependency-state-only commit, dependabot-ish committer) and leaves it checked out — the state the aftercare workflow and `dev/scan.ts` expect. Per-variant quirks are documented in the script.
- No build step: everything except the discovered agent/workflow entrypoints runs directly under plain Node with explicit `.ts` import extensions; tsconfig is maximally strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). `agents/depvisor.ts` is the one exception (Flue-bundler-only `.md` imports); nested `agents/` / `workflows/` support modules are ordinary, plain-node-safe modules — the full split is in `src/CLAUDE.md`.
- For Flue API questions, use the `flue` skill (`flue docs search/read`) rather than guessing — the dependency is a beta.
