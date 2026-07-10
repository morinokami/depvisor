# src/core — the deterministic core

Everything here is LLM-free, unit-tested, and runs under plain `node` (explicit `.ts` import extensions, no build step). **Nothing here may import an agent or workflow module.**

Each module's own rationale lives in its file header — read that first. This file records only what no single file can: the pipeline order, the cross-module policies, and the rules a local-looking change would silently break.

## Pipeline

`config` (parse the knobs) → `preflight` (starting-point gates; pins `pm` — detect + per-PM command table + `updatePlan`) → `collect` (outdated) → `ignore` → `release-age` (cooldown clamp) → `grouping` (stable keys) → `advisories` (ordering) → `bump` (execute the `UpdatePlan`) → `verify` → `scope` (`checkBumpScope` pre-commit, `checkFixScope` post-fixer) → `git` (two-commit split, ref/worktree snapshots) → `test-changes` + `license` (display) → `pr` (payload/sanitize/narrative/labels) → `github` (push, `gh pr create`, labels).

Three ordering constraints are not free to change:

- **`ignore` before `release-age`** — an ignored package must cost no packument fetch and no red `release-age-unavailable`. The price is that `name@<major>` matches the raw registry `latest`, not a clamped version (conservative, on purpose).
- **`release-age` before `grouping`** — the clamp recomputes `updateType`, and the group key (= branch = PR identity) depends on it.
- **`advisories` after `grouping`** — it reorders groups and must never rewrite keys. Promotion by editing a group key would break idempotency.

## Failure policy differs per module on purpose

Do not unify it. The question is always "is this module a defense, a gate, or a display?"

| Module                                               | On failure                                                        | Because                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------- |
| `release-age.ts`                                     | fail-closed — drop the candidate (`release-age-unavailable`, red) | a defense (cooldown), not display |
| `scope.ts`, `bump.ts`, `verify.ts`, `credentials.ts` | fail-closed                                                       | gates                             |
| `advisories.ts`                                      | fail-soft — neutral order, run stays green                        | an optimization (ordering only)   |
| `license.ts`                                         | fail-open — render nothing                                        | display only                      |
| `changelog.ts`                                       | never throws — returns an "unavailable" note                      | display / prompt input            |

`bump.ts` returns every failure as a value (`bump-failed`) rather than throwing.

## Display-only modules never gate

`advisories.ts` (order), `test-changes.ts` (⚠️ section), `license.ts` (⚠️ section), and `status.ts`'s `GroupUsage` all add **no failing status**. They must never change which version installs, the group key, or membership.

The scope gate **cannot deny tests** — adapting a test to a changed API is a legitimate update, indistinguishable from a poisoned fixer weakening an assertion. `test-changes.ts` exists as visibility instead. Do not add a deny for tests.

## Shared leaves

Duplicating one of these is the mistake; adding an obvious fifth helper to one is usually right.

- `version-core.ts` — the x.y.z `Triple` + comparator. depvisor deliberately carries **no semver library**, and each consumer anchors its own parse differently (the header documents all four flavors).
- `manifest.ts` — `DEPENDENCY_FIELDS` + `asPlainMap`, shared by `pm.ts`'s planner and `scope.ts`'s bump gate so the sections one classifies and the other allow-lists cannot drift apart.
- `text.ts` — `tail` (the one end-of-log budget) and `logSafeText`.
- `status-file.ts` — `RUN_STATUS_FILE` alone, so `pr.ts` and `status.ts` avoid an import cycle.

## Untrusted text has exactly two exit boundaries

Registry data (licenses, release notes, packuments) and agent output are both untrusted. Any new display data needs a gate at whichever boundary it reaches.

- **The PR body** — `pr.ts` charset-validates every embedded fragment (paths, license strings, GHSA ids, URL parts), because `sanitizePrBody` deliberately leaves markdown links alone. It also escapes every `<`, so a new section must be plain markdown, never `<details>`. Anything dropped by a charset gate is still counted.
- **The Actions log, step summary, and action outputs** — `text.ts`'s `logSafeText` collapses text to one control-free line (an embedded newline could forge a `::command`), and `status.ts`'s `toActionOutputs` emits **machine-shaped values only**, because outputs feed consumer `${{ }}` interpolation.

## One registry round-trip per package

`release-age.ts` fills a packument cache that the PR body's source-repo links, `license.ts`, and the digest's `fetchReleaseNotes(…, { slug })` all reuse. Do not add a second fetch per member. When the cooldown is disabled, `update.ts` fetches each member's packument once for the same purpose.

## Config parsers share one shape

`budget.ts`, `release-age.ts`, `ignore.ts`, `suggest-features.ts`: an empty string means "not set" (falsy checks, never `??`), matching is exact-string, and an unrecognized value is a **fail-closed run-level `bad-*` status**, never a silent default. Follow this shape for a new knob. Validate even when the feature is disabled, so a typo fails now rather than on re-enable.

`config.ts` sequences all of them into one `parseRunConfig(env)` and owns the rejection summaries; a new knob is a parser plus a field there. It runs **before** `preflight.ts`, so a mistyped knob is reported without touching the target repository (and its `bad-*` status carries no base branch). `DEPVISOR_LLM_MODEL` is deliberately not a `RunConfig` field — it belongs to the agent factory.

## pnpm is the awkward package manager

- `pnpm outdated` reports only the **highest** installed version across workspaces, so `Candidate.currents` there is that single version. Advisory and license matching therefore miss a lower-versioned workspace (fail-soft: the update still fixes every workspace; only the promotion / warning row is lost). npm and bun report every occurrence.
- pnpm has **no command** that moves a catalog entry to a specific version, so `bump.ts` edits `pnpm-workspace.yaml` through the `yaml` Document API and `checkBumpScope` independently allow-lists the resulting diff. Which members are catalog-pinned is decided by reading **every workspace manifest**, never from `Candidate.locations` (see the point above for why).
