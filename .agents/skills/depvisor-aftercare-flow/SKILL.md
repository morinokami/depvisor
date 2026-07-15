---
name: depvisor-aftercare-flow
description: Use when changing or reasoning about depvisor's per-PR aftercare flow in src/workflows/aftercare.ts — preflight, the commit-classification and dependency-diff gates, head verification, merge-base baseline attribution, the fixer and its scope gates, the digest, the publish payload, and which statuses fail the job.
---

# The depvisor aftercare flow

The workflow (`flue run aftercare`) imports the `depvisor` root agent and drives the deterministic verify/attribute/repair sequence itself, delegating only the fixer and digest to its subagent profiles. One run serves ONE updater PR (the checked-out head). `workflows/aftercare.ts` owns config, preflight, the classification/diff gates, and the incremental run record; nested `workflows/aftercare/process-pr.ts` owns the verify → baseline → repair → report gate sequence and returns an explicit outcome.

The invariants this flow must preserve are in the repo-root `CLAUDE.md`. Read them before changing any step below.

## The sequence

0. The composite Action first calls the same `parseRunConfig` through `check-config.ts`, before target install, so input typos return their `bad-*` status without waiting for lifecycle scripts. The workflow repeats `parseRunConfig` (`core/config.ts`: base/head refs, PR number, language — first rejection wins) and then preflight (`core/preflight.ts`: repo root, credentials, clean tree, PM detection pinned once, head branch resolution, base fetchability, merge-base computation, verify steps). Any failure is a run-level stop.

1. **Commit classification** (`dep-diff.ts:classifyPrCommits`) — before any install, verification, or token is spent. Every commit in `mergeBase..head` must either touch only dependency-state paths (`scope.ts:isDependencyStatePath` — the updater's legitimate surface) or carry depvisor's own committer sentinel (a previous repair). Anything else is the green `not-an-update-pr` skip: a human owns work on that branch and depvisor never builds repairs on human work. An empty range and a diff with no nameable dependency change skip the same way.

2. **Dependency diff** (`dep-diff.ts:diffDependencies`) — the change set the fixer prompt, the report, and the status name. Lockfile-resolved when both sides' lockfiles parse (this catches Dependabot's lockfile-only in-range updates); manifest-specifier fallback otherwise (fail-soft — it feeds display/prompt only, never a gate).

3. **Head verification** (`process-pr.ts`) under the pre-installed head dependency state. A `RefGuard` is captured before this first untrusted execution and checked at every boundary, failures included; a verification that dirties the tree is `scope-violation`. Green head → no baseline, no fixer; skip to the digest/report (status `report-prepared`).

4. **Baseline attribution** — only for a red head. Detach onto the merge base, reinstall its lockfile state (`resolveResetCommand`; `reinstall-unavailable` when `install_command: skip` meets no lockfile, `reinstall-failed` on install failure), verify. A red or dirty baseline is `baseline-red`: the failure cannot be attributed to the update, so no repair is attempted (fail-closed, run-level stop). A green baseline authorizes the fixer; return to the head branch and reinstall its state.

5. **Fixer** — `session.task(..., { agent: "fixer", result: FixerResult })` gets a bounded prompt: the dependency changes, **manifest diff hunks only** (`git.ts:manifestDiff`; lockfiles never as hunks), the failing steps with bounded output tails (`verify.ts` captures a `tail` internally; `stripVerifyTails` removes it before persistence), the source-only constraint, and verify command names. The fixer inspects/edits only through the repo-jailed custom tools and cannot run checks itself. No validated result → fail-closed `no-structured-result`. A `defer` discards leftovers and still produces a report payload (status `deferred`, green — the report explaining the blocker IS the deliverable).

6. **Repair gates** — authoritative regardless of what the fixer claims: `checkFixScope(repo, headSha)` before verification; `snapshotWorktree` captures the exact allowed fixer diff; full re-verification runs; refs/HEAD are checked; `worktreeDrift` rejects ANY verification-authored change; `checkFixScope` runs a second time immediately before `commitAll`. A still-red re-verification discards the attempt (never committed) and prepares a `verification-failed` report payload (red — the PR remains broken and users must notice). A scope violation is a payload-less stop. Only a green, in-scope repair becomes the single `fix: adapt code to <pkgs> update` commit (committer = the depvisor sentinel; status `repair-prepared`).

7. **Report** — classify the repair's committed diff for test changes (`test-changes.ts`, display only), fetch packuments/release notes deterministically, run the **digest** (`session.task(..., { agent: "digest", result: DigestResult })`, always, strictly after any repair commit is sealed; fail-soft on `FlueError` / `ResultUnavailableError` / Valibot rejection). The post-digest ref/tree seal restores drift and drops the narrative rather than failing a verified repair. Compose the comment (`report.ts:buildReportComment` — deterministic verdict line + sanitized narrative) and emit the single publish payload (`pr-preview/payload.json`: PR identity, expectedHeadSha, repairSha or null, commentBody).

8. **Publish** (token-holding `publish.ts` → `github.ts:publishAftercare`, a separate Action step): verify the PR is still open on the trusted head ref, compare-and-swap — push the repair only while the remote tip equals `expectedHeadSha` (a moved head or closed PR is the green `publish-blocked`), re-verify the pushed range structurally (descent, sentinel committers, `repairScopeViolations`-clean diff), then upsert the ONE marker-deduplicated report comment. PR identity comes from trusted env; the payload must agree. A real error is `publish-failed` (red).

## The status vocabulary

- Green: `report-prepared`, `repair-prepared`, `not-an-update-pr`, `deferred`, `publish-blocked`.
- Red (fails the job): `in-progress` (the crash marker the workflow writes up front — only a graceful finish upgrades it), `bad-base-ref`, `bad-head-ref`, `bad-pr-number`, `bad-language`, `not-a-repo-root`, `persisted-credentials`, `dirty-tree`, `unsupported-package-manager`, `ambiguous-package-manager`, `missing-base-ref`, `no-verify-scripts`, `baseline-red`, `reinstall-unavailable`, `reinstall-failed`, `verification-failed`, `scope-violation`, `unexpected-commits`, `no-structured-result`, `publish-failed`.

`aftercare.ts` writes `pr-preview/status.json` incrementally under the red `in-progress` marker, so a mid-run crash fails the job instead of impersonating a green run; `publish.ts` patches the publish outcome (comment URL, or a blocked/failed status) back into the same file, and `report-status.ts` projects it into annotations, the step summary, and the machine-shaped action outputs.

## Adding a status

A new status must be classified in `status.ts` (the `OK_STATUSES` green set vs everything-else red) and, if it is a config-parse stop, follow the `bad-*` convention. Statuses also appear in the composite action's `outputs:` via `toActionOutputs`, which drops anything off the kebab-case vocabulary. Mirror any new status name into `docs/results.md` (the status reference) and `start.md`, which duplicate the list on purpose.
