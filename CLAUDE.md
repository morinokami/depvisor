# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

depvisor is an AI agent, shipped as a GitHub **composite action** (`action.yml`), that does what a human does to a Dependabot-style dependency-update PR: investigate, update, fix breakage, verify, and open the PR. Keep `README.md` in sync when behavior changes.

**Whenever you change code, check whether this file (CLAUDE.md) is still accurate — commands, architecture, invariants, gotchas — and update it in the same change if not.**

## Commands

depvisor itself uses **pnpm** (the default fixture is an npm project; a pnpm variant exists). Node >= 22.19 required (Flue; declared in package.json `engines`).

```bash
pnpm test                                    # unit tests (node --test), no API key
node --test test/grouping.test.ts            # single test file
pnpm run typecheck && pnpm run lint && pnpm run fmt:check && pnpm run knip
                                             # CI gates (plus test) — all must pass
node src/dev/scan.ts fixtures/sample-app --verify   # deterministic core E2E, no API key
pnpm run fixture:init                        # create the throwaway fixture (required before agent runs)
pnpm run fixture:init:pnpm                   # pnpm variant → fixtures/sample-app-pnpm (tests PM detection)
pnpm exec flue run update-one                # agent run; needs API key + DEPVISOR_MODEL in .env
node src/open-pr.ts                          # push + PR from emitted payload; needs GH_TOKEN + remote
cd fixtures/sample-app && git checkout -f main && npm install        # reset fixture to green baseline
```

Fixture agent run (scans and picks a group itself, same path as CI):
`DEPVISOR_TARGET_REPO="$PWD/fixtures/sample-app" pnpm exec flue run update-one`

## Architecture

One split governs everything: **deterministic code does anything needing reproducibility, idempotency, or safety; the agent only does investigate/update/fix/verify-loop work, boxed between deterministic gates.**

### Modules

- `src/core/` — deterministic, LLM-free, unit-tested: pm (package-manager detection + per-PM command table) → collect (npm/pnpm outdated) → grouping (stable keys) → verify gate → scope gate → git (two-commit split) → pr (payload/sanitize) → github (push + `gh pr create`).
  - `changelog.ts` is also here: the deterministic backing for the agent's bounded `fetch_release_notes` tool. Fixed endpoints (npm registry + GitHub Releases); it never throws, returning an "unavailable" note instead.
  - `resolveSourceRepo` (same file) is what the workflow uses to attach releases/compare links to the PR body. Fail-soft: unresolved → no links. `pr.ts` charset-validates every URL part at the embed boundary because the sanitizer leaves markdown links alone.
  - `status.ts` is the deterministic status/summary boundary for Actions log UX. `update-one.ts` writes `pr-preview/status.json` on every known return path; `report-status.ts` turns it into annotations and `$GITHUB_STEP_SUMMARY` Markdown.
- `src/agents/updater.ts` (+ `updater.md` instructions) and `src/workflows/update-one.ts` — the only LLM-driven code (`src/tools/` and `flue.config.ts` also touch Flue APIs, but stay LLM-free).
  - The `defineAgent` updater lives in `src/agents/` per Flue's discovery convention (filename = agent name); it exports no `route`, so it is never HTTP-exposed. Its instructions are imported from `updater.md` (`with { type: "markdown" }`, Flue's convention).
  - The agent carries one bounded tool, `fetch_release_notes` (`src/tools/release-notes.ts` — `defineTool`, backed by `core/changelog.ts`) — the single narrow door for untrusted external text, never raw agent HTTP.
  - Tool definitions live in `src/tools/` (not auto-discovered by Flue; imported and attached via `tools:`).
- `src/shared/target.ts` — the one value both the agent (its `cwd`) and the workflow share: `REPO`, the target checkout in CI / throwaway fixture locally.
- `src/open-pr.ts` — the deterministic, token-holding entrypoint: push + `gh pr create` from the emitted payload, then patch the status file with the PR URL or open-pr failure. The ONLY command that needs `GH_TOKEN`; in CI it runs as its own Action step.
- `src/report-status.ts` — the deterministic Actions log UX entrypoint. It reads `pr-preview/status.json`, emits a notice/error annotation, appends a Markdown step summary, and exits non-zero for non-benign no-PR statuses.
- `src/check-credentials.ts` — the plain-node entrypoint for the credentials gate: fails the job with `::error` when `core/credentials.ts` finds persisted credentials in the target checkout. Runs as the first target-touching Action step — **before** the target install (whose lifecycle scripts must not see a token either) and regardless of `install_command`.
- `src/install-target.ts` — the plain-node entrypoint behind `install_command: auto`: detects the target's PM and runs the matching lockfile-faithful install (`npm ci` / `pnpm install --frozen-lockfile`) before the agent step.
  - It fails the job with a clear `::error` for unsupported/ambiguous PMs AND for repos without a committed lockfile — a bare `npm install` would create the lockfile and dirty the pre-agent tree, which preflight would later reject as an illegible `dirty-tree`.
- `src/dev/scan.ts` — a developer-only tool (no key) that runs detect → collect → group → verify against a repo and prints it. NOT part of the CI/composite-action flow, hence its home under `dev/`.

### The update-one flow

The workflow imports the updater agent and drives it:

1. Preflight → pick group (or skip if the open PR is already up to date).
2. Baseline verification on the base tip (`baseline-red` → no agent run).
3. Agent session, returning a **structured result** (`session.prompt` with a Valibot `result` schema: summary / notable_changes / breaking_changes_addressed / residual_risks / verdict). notable_changes entries for packages outside the update group are dropped deterministically at render time.
4. Deterministic gates (`unexpected-commits`, `scope-violation`, verification) — authoritative regardless of what the agent claims.
5. Two commits → emit PR payload to `pr-preview/` and status to `pr-preview/status.json`.

- The workflow branches on `verdict`: `defer` → no PR, `deferred` status; leftover commits/tree changes from the deferred attempt are discarded deterministically, not trusted away.
- It fails closed (`no-structured-result`) when the agent can't produce validated data (`ResultUnavailableError` or the defensive re-parse).
- The composite action reports the status file after the token-holding open-pr step. `pr-prepared`, `pr-up-to-date`, `no-updates`, and `deferred` stay green; statuses such as `baseline-red`, `no-verify-scripts`, `scope-violation`, `verification-failed`, `missing-base`, and `open-pr-failed` become job failures so silent no-PR outcomes notify users.

### Invariants

Preserve these when changing the flow above.

- **Token separation is structural, not instruction-based**: the agent step holds only the LLM key; GitHub tokens exist only in the snapshot and open-pr steps, with `persist-credentials: false` on checkout. Never hand the agent step a token or let the agent run git/GitHub operations.
  - The user's checkout can defeat the separation from outside (actions/checkout defaults to `persist-credentials: true`), so `core/credentials.ts` fail-closes on persisted credentials in the checkout's repo-**local** git config: Authorization extraheaders (URL-scoped or not), userinfo in http(s) remote url/pushurl and in `url.*.insteadOf`/`pushInsteadOf` rewrites, `core.sshCommand`, repo-local credential helpers. The config read follows include directives (`--includes` in `localConfigEntries`) because checkout v6+ persists the token in a separate RUNNER_TEMP file referenced via `include.path` from the repo-local config. Enforced twice — the `check-credentials.ts` Action step, and the `persisted-credentials` preflight status covering local/non-action runs. Best-effort over known vectors, not a guarantee. Findings never include config values, and redact URL subsections from keys — both positions can carry the secret (`url.<https://token@…>.insteadOf` puts it in the key).
- **Branch name = stable group key = PR identity**: changing grouping or naming logic changes PR identity and breaks idempotency/skip-if-up-to-date.
- **Package-manager detection is pinned at preflight** (`core/pm.ts`, called once in `update-one.ts` preflight against the trusted base tree; also by `install-target.ts` and `dev/scan.ts`).
  - Supported: npm + pnpm; yarn/bun and ambiguous lockfile mixes fail closed (`unsupported-package-manager` / `ambiguous-package-manager`, no agent run).
  - Never re-detect after the agent has run — lockfiles are agent-writable, so post-agent detection would let the agent switch which commands the trusted steps execute.
  - The detected `pm` drives collect, verify `run` prefixes, the agent's update-command instruction, and the manifest set of the two-commit split.
  - The scope gate guards the corresponding surfaces, diffed against base: a path deny-list (PM config files, CI config, git hooks) plus guarded package.json fields. The exact lists are `DENY` and `GUARDED_FIELDS` in `core/scope.ts` — extend them when adding a PM or any new execution surface, and mirror path additions in `agents/updater.md` so the agent avoids them instead of burning a run on a scope violation.
- **The verification gate refusing to vouch (`no-verify-scripts`) means no PR**, by design.
  - Verify steps come from script auto-detection (`build`/`lint`/`test` — `typecheck` deliberately not detected), or from the `verify_commands` input (`DEPVISOR_VERIFY_COMMANDS`, newline-separated shell commands), which **replaces** auto-detection entirely.
  - `verify_commands` must only ever come from the workflow file/env, never from the agent-writable target tree.
  - The same gate also runs on the base tip **before the agent** (`baseline-red`): a red baseline means no agent run and no PR, so post-update failures are always attributable to the update.
- **`.git/` is outside the scope gate (it only sees the working tree), so it is treated as attacker-writable.**
  - Every git invocation disables local hooks (`NO_HOOKS = -c core.hooksPath=/dev/null`, exported from `git.ts`, reused in `github.ts`). Never add a git call that bypasses `run()`/the `git()` wrapper.
  - The token-holding open-pr step runs entirely inside a fresh clone (`prepareCleanPush` in `github.ts`), because `.git/config` alone is a rich command-execution surface (`credential.helper=!cmd` fires on push auth, plus `core.fsmonitor`, `diff.external`, `filter.*`, …) that hook-disabling does not cover. Do not make the open-pr step operate on the target checkout's `.git`.
  - The push **target** is equally untrusted: in CI it comes from `DEPVISOR_REMOTE_URL` (Actions context `${server_url}/${repository}`); only when that is unset (local dev on a trusted machine) does it fall back to the checkout's `remote.origin.url` — the one read the open-pr step performs against the target checkout's `.git`. Either way it must pass `isNetworkRemote` — a push to a local/`file:`/helper remote would run that remote's server-side hooks in this `GH_TOKEN` process.
  - The payload's **`title`/`body` are untrusted at this boundary too** (written by the tokenless step): `openPrWithGh` re-sanitizes them at the exit (`sanitizePrBody`, preserving only a strictly-validated versions marker), just as it re-validates `base` and branch authorship.
  - The **inherited environment** is untrusted too (`local()` gives no isolation, so the agent can write `$HOME/.gitconfig` or inject via `$GITHUB_ENV`/`$GITHUB_PATH`): all git/gh in `github.ts` run via `buildSecureEnv` (token env allowlist only, clean HOME/XDG/GH config dir, `GIT_CONFIG_NOSYSTEM=1`, no inherited `GIT_*`/loader/exec env, PATH pinned, binaries by absolute path). Keep every subprocess in this module on that env.
- **Keep the Flue dependency thin**: `defineAgent` / `defineWorkflow` / `defineTool` / `session.prompt` (incl. its `{ result }` structured-output option) / workflow `log` / `ResultUnavailableError`, exact-pinned beta.
  - `defineTool` + `{ result }` were a deliberate expansion for the release-notes tool and structured output; keep the rest thin so the AI-SDK escape hatch stays open.
  - All are "Flue lets you not write it" rather than "only Flue can express it," so portability is preserved.

### Development workflow

`.github/workflows/depvisor.yml` is the **development** workflow: it runs the composite action from the checkout via `uses: ./`, matching consumer workflows except for `uses: ./` and `install_command: skip` (the target is depvisor itself, a pnpm repo — the action's own `pnpm install` covers it).

The composite action has two documented GitHub-runner quirks (nested `uses:` doesn't evaluate `github.action_path`; pnpm/action-setup breaks absolute paths) — read the comments in action.yml before touching it.

## Gotchas

- Env config treats **empty strings as "not set"** everywhere (`||`/falsy checks, never `??` — see `update-one.ts`, `agents/updater.ts`, `shared/target.ts`, `open-pr.ts`): the composite action forwards unset inputs as empty strings. `DEPVISOR_MODEL` has **no default** — the agent factory throws if it's unset/empty (action.yml fail-fasts earlier with a clearer `::error`, since GitHub doesn't enforce `required:` on action inputs).
- `npm outdated` / `pnpm outdated` read the **installed tree**: without an install in the fixture, candidates are hidden. Both exit 1 when updates exist (JSON still on stdout); pnpm needs `--format json` and its entries carry `dependencyType` (npm's don't — hence the separate parsers in `collect.ts`).
- `fixtures/sample-app/` (npm) and `fixtures/sample-app-pnpm/` are gitignored throwaway git repos generated from the shared `sample-app.template/` (committed; it deliberately contains code that the lru-cache major update breaks). The pnpm variant gets its own `pnpm-workspace.yaml` written by `init-fixture.sh` — without it, pnpm walks up and captures the fixture into **depvisor's own workspace**, installing nothing locally.
- No build step for the deterministic core: `src/core/`, `src/open-pr.ts`, `src/report-status.ts`, `src/install-target.ts`, `src/check-credentials.ts`, `src/dev/scan.ts`, and the tests run directly under Node with explicit `.ts` import extensions; tsconfig is maximally strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
  - The **agent module is the exception**: `agents/updater.ts` uses a Flue-bundler-only `.md` import (`with { type: "markdown" }`), so it is loadable only under `flue run`/`flue build`, not plain `node` (`ERR_UNKNOWN_FILE_EXTENSION`).
  - Keep it that way — nothing on a plain-node path (tests, `open-pr.ts`, `report-status.ts`, `install-target.ts`, `check-credentials.ts`, `dev/scan.ts`, `core/`) may import an agent/workflow module.
- For Flue API questions, use the `flue` skill (`flue docs search/read`) rather than guessing — the dependency is a beta.
