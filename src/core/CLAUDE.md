# src/core — the deterministic core

Everything here is LLM-free, unit-tested, and runs under plain `node` (explicit `.ts` import extensions, no build step). **Nothing here may import an agent or workflow module.**

Each module's own rationale lives in its file header — read that first. This file records only what no single file can: the pipeline order, the cross-module policies, and the rules a local-looking change would silently break.

## Pipeline

`config` (parse the knobs) → `preflight` (starting-point gates; pins `pm`, resolves head/merge-base) → `dep-diff` (commit classification + the dependency change set) → `verify` (head, then — red only — the merge-base baseline) → `scope` (`checkFixScope` around the fixer) → `git` (the repair commit, ref/worktree snapshots) → `test-changes` (display) → `report` (comment/payload/sanitize) → `github` (publish: compare-and-swap push + comment upsert).

Two ordering constraints are not free to change:

- **Commit classification before any verification or LLM work** — a PR carrying human work (`not-an-update-pr`) must cost no install, no verification, and no tokens.
- **Head verification before the baseline** — a green head needs no attribution, so the common case pays for one verification and zero extra installs. Only a red head buys the merge-base checkout + reinstall + baseline verification, whose green result is what authorizes the fixer (`baseline-red` otherwise, fail-closed).

## Failure policy differs per module on purpose

Do not unify it. The question is always "is this module a defense, a gate, or a display?"

| Module                                    | On failure                                        | Because                              |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| `scope.ts`, `verify.ts`, `credentials.ts` | fail-closed                                       | gates                                |
| `dep-diff.ts` commit classification       | fail-closed (`not-an-update-pr`, green skip)      | a boundary of what depvisor consumes |
| `dep-diff.ts` lockfile parsing            | fail-soft — manifest-specifier fallback           | display/prompt input, never a gate   |
| `packument.ts`                            | fail-open — null, no links/notes                  | display only                         |
| `changelog.ts`                            | never throws — returns an "unavailable" note      | display / prompt input               |
| `github.ts` publish                       | blocked (green) for churn; failed (red) otherwise | the exit boundary                    |

## Display-only signals never gate

`test-changes.ts` (⚠️ report section), the report's source links, transitive counts, and `status.ts`'s `OpUsage` all add **no failing status**. They must never change the verification verdict, the repair scope, or what gets pushed.

The scope gate **cannot deny tests** — adapting a test to a changed API is a legitimate repair, indistinguishable from a poisoned fixer weakening an assertion. `test-changes.ts` exists as visibility instead. Do not add a deny for tests.

## Shared leaves

Duplicating one of these is the mistake; adding an obvious extra helper to one is usually right.

- `version-core.ts` — the x.y.z `Triple` + comparator. depvisor deliberately carries **no semver library**; each consumer anchors its own parse (the header documents the flavors).
- `manifest.ts` — `DEPENDENCY_FIELDS` + `asPlainMap`, shared by `dep-diff.ts`'s declaration reader and anything else that classifies manifest sections.
- `scope.ts` — the ONE definition of "dependency state" (`isDependencyStatePath`) and of the repair scope rule (`repairScopeViolations`), consumed by the fixer gate, the commit classification, AND the publish boundary's re-check. Splitting these vocabularies is how the updater's surface and the fixer's denies would drift apart.
- `text.ts` — `tail`, the one end-of-log budget.
- `status-file.ts` — the status filename alone, so cleanup can share it without importing the status renderer.
- `ref-guard.ts` — the per-run expected-ref state over `git.ts`'s snapshot/diff/restore leaves; policy stays in the workflow because target-script drift fails the run while post-digest drift is display-only.

## Untrusted text has exactly two exit boundaries

Registry data (release notes, packuments) and agent output are both untrusted. Any new display data needs a gate at whichever boundary it reaches.

- **The report comment** — `report.ts` charset-validates every embedded fragment (paths, versions, slugs, URL parts), because `sanitizeSummary` deliberately leaves markdown links alone. It also escapes every `<`, so a new section must be plain markdown, never `<details>`. Anything dropped by a charset gate is still counted. The publish step re-sanitizes the whole body at the exit (`sanitizeCommentBody`), preserving only the strictly-validated trailing aftercare marker.
- **The Actions log, step summary, and action outputs** — `status.ts`'s `oneLine` collapses summaries to one control-free line and defuses a leading `::` (an embedded newline could forge a `::command`), and its `toActionOutputs` emits **machine-shaped values only**, because outputs feed consumer `${{ }}` interpolation.

## Config parsers share one shape

`config.ts` (refs, PR number) and `language.ts`: an empty string means "not set" (falsy checks, never `??`), matching is exact-grammar, and an unrecognized value is a **fail-closed run-level `bad-*` status**, never a silent default. Follow this shape for a new knob. `config.ts` sequences the parsers into one `parseRunConfig(env)` and owns the rejection summaries; a new knob is a parser plus a field there. `check-config.ts` calls it in the Action before target install, and the workflow repeats it before `preflight.ts` for defense in depth/status ownership, so a mistyped knob is reported without touching the target repository. `DEPVISOR_LLM_MODEL` is deliberately not a `RunConfig` field — it belongs to the agent factory.

## Lockfile parsing is bounded on purpose

`dep-diff.ts` reads three lockfile dialects (npm JSON v1–v3 `packages`/`dependencies`, pnpm YAML v6–v9 `packages`/`snapshots` keys, textual `bun.lock` JSONC) into a plain name→versions map — nothing more. It exists so the report can name resolved versions and catch Dependabot's lockfile-only in-range updates; it is NOT a resolver, and any parse failure degrades to the manifest-specifier fallback (`lockfileResolved: false`) rather than failing the run. The binary `bun.lockb` is deliberately unreadable here. pnpm `catalog:` specifiers resolve through `pnpm-workspace.yaml` at the same ref in `declaredDependencies`, so a catalog-pinned bump surfaces like any other spec change.
