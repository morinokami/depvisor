---
name: depvisor-update-flow
description: Use when changing or reasoning about depvisor v2's one-PR repair/review flow — workflow_run context, updater ownership, the local Flue agent, dependency-state publication boundary, fresh-clone repair push, report comment, and statuses.
---

# depvisor v2 per-PR flow

v2 consumes one existing Dependabot/Renovate PR. It contains no outdated scan,
version selection, grouping, cooldown, deterministic bump, branch naming, PR
creation, or open-PR budget. Those are updater responsibilities.

## Flow

1. A consumer `workflow_run` starts after its named CI completes and checks out
   `workflow_run.head_sha` with persisted credentials disabled.
2. `prepare.ts` uses a token read-only to resolve the PR, require an open
   same-repository recognized Dependabot/Renovate head, validate checkout HEAD,
   list the original changed paths, and collect globally bounded patches plus
   paginated jobs and bounded failed-job logs.
3. It freezes every updater path plus recognized dependency manifests/lockfiles.
   The context and snapshot live under `runner.temp`, outside the target repo.
4. `flue run repair` prompts the root agent once. The agent uses `local()` with
   the checkout as cwd, giving it real files, shell, tools, and network. It may
   investigate upstream changes, run installs/checks, and edit source/tests/config.
   It must leave edits uncommitted and return structured evidence.
5. The workflow requires unchanged HEAD and unchanged frozen dependency state,
   then captures tracked binary diff plus untracked files. A `defer` may produce
   a report but never publishes its leftover edits.
6. `publish.ts` revalidates the context/snapshot, current open PR head, dependency
   state, and byte-identical captured repair. For a ready repair it applies the
   repair in a fresh clone, creates one commit, and pushes with force-with-lease
   to the existing updater ref. It never creates a PR or targets a fork. The
   handoff is capped at 200 files and 5 MiB of patch/new-file content.
7. The publisher creates or updates one marker comment containing upstream
   relevance, repair details, command evidence, and residual risks. A later CI
   run updates the same comment.
8. `report-status.ts` exposes fixed machine outputs and fails the Action for any
   incomplete/unsafe/infrastructure outcome.

## Statuses

Green: `reviewed`, `repair-published`, `deferred`, `unsupported-pr`, `stale-pr`.

Failing: `setup-failed`, `wrong-head`, `agent-failed`,
`dependency-state-changed`, `publish-failed`, `in-progress`.

Update status classification in `core/status.ts`, `action.yml`,
`docs/results.md`, and `start.md` together.

## Trust model

The agent is intentionally auto-mode powerful and local() is not an isolation
boundary. GitHub credentials remain out of its step, and the updater-ownership
check remains mechanical. External CI is the merge authority; agent verification
is recorded evidence. Source hashing and env scrubbing do not stop same-UID
residual processes, runner-writable toolchain/PATH replacement, run-temp status
tampering, or malicious install scripts from reaching a later step. Never
reintroduce a claim that the model's verdict itself proves CI green or that the
current same-job token boundary is OS isolation.
