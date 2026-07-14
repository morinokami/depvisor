# depvisor v2 contributor guide

depvisor turns an existing Dependabot or Renovate pull request into a green,
reviewable PR. It does not discover updates, select versions, edit dependency
state, group updates, own updater branches, or create/merge PRs. Dependabot or
Renovate remains the single source of truth for updater policy and lifecycle.

Whenever behavior changes, update `README.md`, the self-contained agent setup
guide `start.md`, and the owning reference page in `docs/` in the same change.

## Commands

Node >= 24 and pnpm are required.

```bash
pnpm test
node --test test/provider.test.ts
pnpm run check
actionlint
zizmor --persona=auditor --min-confidence=high .
```

## Architecture

Provider and ecosystem are independent axes:

- `src/providers/`: trusted GitHub actor/commit attestation and updater refresh
  semantics for Dependabot and Renovate.
- `src/ecosystems/`: read-only dependency diff extraction. JavaScript package
  manifests and Go modules currently reach `repair-safe`; incomplete parsing
  degrades the whole PR to generic review.
- `src/core/`: normalized schemas, trusted base-SHA config, policy, git/ref and
  worktree guards, verification, source/test scope, result and report rendering.
- `src/agents/` + `src/workflows/aftercare.ts`: the only LLM work. The fixer is
  failure-only and one-shot; the reviewer is read-only and fail-soft.
- `src/cli/`: isolated GitHub Actions job entrypoints. The publisher is the only
  entrypoint with a GitHub write token.
- `.github/workflows/depvisor.yml`: the public reusable workflow and security
  boundary. `action.yml` and the v1 composite-action interface no longer exist.

## Invariants

- The unit of work and idempotency key is the immutable PR head plus base tip and
  trusted config digest, never a branch-derived dependency group.
- Configuration comes only from `.github/depvisor.yml` at the PR base-tip SHA.
  Never read behavior-shaping config or commands from the updater head.
- Provider identity comes from GitHub API actor/commit fields. A branch prefix,
  title, label, or PR body grants no authority.
- Review uses `merge-base...updaterHeadSha`; repair additionally requires that
  merge base to equal the current base tip and the updater branch to be in-repo.
- The updater owns all manifests, lockfiles, dependency config, and branch
  regeneration. depvisor may create at most one disposable source/test repair
  commit for one provider-owned head.
- Repair is all-or-nothing across the PR. Every dependency update must be
  `repair-safe`; one unknown ecosystem or unclassified updater path disables it.
- Baseline and head verification run in separate clean jobs and confirm failures.
  A green base plus stable red head is the only path to the fixer. Candidate
  verification is authoritative and cannot be retried into acceptance.
- The fixer and reviewer have Flue's in-memory sandbox. `repo-files.ts` is the
  only host bridge; reviewer gets read/search, fixer gets bounded repo-relative
  writes, and `.git`/symlink/`..` escapes are rejected. Never introduce `local()`
  or a host shell without an OS-level isolation replacement.
- Scope checks deny adapter-protected dependency state and execution surfaces,
  and allow only recognized source/test paths. Tests remain visible in reports.
- Target code, LLM credentials, and GitHub write credentials run in different
  jobs. Checkout always uses `persist-credentials: false`; secrets are mapped
  explicitly, never inherited.
- Publisher uses a short-lived App token (PAT fallback), re-queries base/head and
  provider ownership, revalidates patch hash/scope in a fresh clone, performs a
  normal non-force push, then upserts its marker comment/check. It never executes
  target code or consumes the target checkout's `.git` config.
- Repeated events on a recognized depvisor repair never stack another repair. A
  red rerun requests provider regeneration; a green rerun reports it applied.

## Flue boundary

Keep Flue usage thin: `defineAgent`, `defineAgentProfile`, `defineWorkflow`,
`defineTool`, the default virtual sandbox, `harness.session`, `session.task`,
structured result/usage data, `FlueError`, and `ResultUnavailableError`. For API
questions use the repo's `flue` skill and installed `flue docs`, not memory.

## Distribution

The v2 interface is the reusable workflow at
`.github/workflows/depvisor.yml@v2`. Release Please remains manifest-mode. Its
dynamic major/minor tag job moves `v2`/`v2.0` for v2 releases and leaves the
existing v1 tags on the final v1 release line. Each called-workflow job checks
out depvisor from `job.workflow_repository` at `job.workflow_sha`; never add a
second source-ref input that can drift from the caller's selected workflow.
