---
name: depvisor-update-flow
description: Use when changing or reasoning about depvisor v2's one-PR review/fix flow — workflow_run context, updater ownership, the local Flue agent, the frozen dependency files, fresh-clone fix push, report comment, and statuses.
---

# depvisor v2 per-PR flow

v2 consumes one existing Dependabot/Renovate PR. It contains no outdated scan,
version selection, grouping, cooldown, deterministic bump, branch naming, PR
creation, or open-PR limit. Those are updater responsibilities.

## Flow

1. A consumer `workflow_run` starts after its named CI completes and checks out
   `workflow_run.head_sha` with persisted credentials disabled.
2. `prepare.ts` uses a token read-only to resolve the PR, require an open
   same-repository PR from a recognized Dependabot/Renovate account, validate
   checkout HEAD, list the original changed paths, and collect globally bounded
   patches plus paginated jobs and bounded failed-job logs. When the triggering
   CI is green and the maintained comment's state line already records this
   exact head reviewed on green CI by the same depvisor version, it stops with
   `already-reviewed` instead of re-running the agent; the line lives in an
   editable comment, so it is trusted only for skipping that duplicate review.
3. It freezes every updater path plus recognized dependency manifests/lockfiles.
   The context and snapshot live under `runner.temp`, outside the target repo.
4. `flue run fix` prompts the root agent once. The agent uses `local()` with
   the checkout as cwd, giving it real files, shell, and network, plus the
   read-only `fetch_release_notes`/`diff_npm_package` tools for bounded,
   credential-free upstream evidence. It may investigate upstream changes, run
   installs/checks, and edit source/tests/config. Upstream claims in its report
   must cite fetched sources or the PR-body notes. It must leave edits
   uncommitted and return structured evidence.
5. The workflow requires unchanged HEAD and unchanged frozen dependency files,
   then captures tracked binary diff plus untracked files. A `defer` verdict may
   produce a report but never publishes its leftover edits.
6. `publish.ts` revalidates the context/snapshot, current open PR head, dependency
   files, and byte-identical captured fix. For a ready fix it applies the fix
   in a fresh clone, creates one commit, and pushes with force-with-lease
   to the existing updater ref. It never creates a PR or targets a fork. The
   handoff is capped at 200 files and 5 MiB of patch/new-file content.
7. The publisher creates or updates one comment, identified by a hidden marker,
   containing upstream relevance, fix details, command evidence, and residual
   risks. A later CI run updates the same comment; the fix push itself does
   not start one with the default `github_token` (GitHub can gate the new
   head's CI behind approval and delivers no `workflow_run` event for a CI run
   originally triggered by that token's push, even after a rerun), so the
   refresh pass waits for the next updater- or human-initiated event or an
   App/PAT `github_token`. For a no-fix review the comment also embeds the
   reviewed-head state line that enables the `already-reviewed` skip.
8. `report-status.ts` exposes a fixed set of machine-readable outputs and fails
   the action for any incomplete/unsafe/infrastructure outcome.

## Local run

There is no standalone discovery mode: `flue run fix` consumes the files
`prepare.ts` produces for a real updater PR.

```bash
run=/tmp/depvisor-run
GH_TOKEN=… DEPVISOR_REPOSITORY=owner/repo DEPVISOR_PR_NUMBER=123 \
  DEPVISOR_TARGET_REPO=/path/to/pr-head-checkout \
  DEPVISOR_RUN_DIR="$run" DEPVISOR_STATUS_FILE="$run/status.json" \
  DEPVISOR_CONTEXT_FILE="$run/context.json" node src/prepare.ts
DEPVISOR_TARGET_REPO=/path/to/pr-head-checkout DEPVISOR_LLM_MODEL=openai/gpt-5.5 \
  DEPVISOR_CONTEXT_FILE="$run/context.json" DEPVISOR_STATUS_FILE="$run/status.json" \
  DEPVISOR_PAYLOAD_FILE="$run/fix.json" pnpm exec flue run fix
```

The checkout must be the PR's current head with a clean tree, and the model
provider key must sit in the provider env var (`OPENAI_API_KEY` etc.).

## Statuses

Green: `reviewed`, `already-reviewed`, `fix-pushed`, `deferred`,
`unsupported-pr`, `stale-pr`.

Failing: `setup-failed`, `head-mismatch`, `agent-failed`,
`dependency-files-changed`, `publish-failed`, `incomplete`.

Update status classification in `core/status.ts`, `action.yml`,
`docs/results.md`, and `start.md` together.

## Trust model

The agent is intentionally as powerful as an autonomous coding agent, and
local() is not an isolation boundary. GitHub credentials remain out of its step,
and the updater-ownership check remains mechanical. External CI remains the
merge gate; agent verification is recorded evidence. Source hashing and env
scrubbing do not stop lingering same-UID processes, runner-writable
toolchain/PATH replacement, tampering with status files under `runner.temp`, or
malicious install scripts from reaching a later step. Never reintroduce a claim
that the model's verdict itself proves CI green or that the current same-job
token boundary is OS isolation.
