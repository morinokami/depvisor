# v2 deterministic boundary

The core no longer updates dependencies or runs verification. It supports one
agent-driven PR repair with a deliberately small mechanical boundary.

Pipeline:

`run-context` → `dependency-state snapshot` → agent → `HEAD/state recheck` →
`repair-payload` → fresh-clone publication → status.

- `dependency-state.ts` freezes all updater-changed paths and recognized
  dependency files. Discovery is filesystem-only and executes no target code.
- `git.ts` captures tracked binary diffs plus untracked files without accepting
  an agent-authored commit. Publication is capped at 200 files / 5 MiB. The
  module also supplies repo-local credential inspection.
- `context-budget.ts` and `pagination.ts` bound PR patches and workflow-job
  context before it reaches the model.
- `apply-repair.ts` materializes new files without following symlink parents.
- `paths.ts` is the one lexical validator for untrusted repository-relative
  paths; `json.ts` is the shared record guard for validated handoffs.
- `upstream.ts` fetches bounded upstream evidence (GitHub releases/CHANGELOG,
  npm tarball diffs) for the agent's read-only tools. It holds no credential,
  pins its hosts, validates every coordinate lexically, and extracts npm
  tarballs itself — regular files only, each path through `paths.ts`.
- `text.ts` owns PR-comment and step-summary rendering boundaries.
- `agent-result.ts` is evidence/report structure, never an attestation.
- `repair-payload.ts` validates the token-free handoff to publication.
- `run-context.ts` validates the prepared PR/CI snapshot and updater identity.
- `status.ts` owns the fixed one-PR status record and fail/green classification.

Keep these properties:

- Frozen paths are compared by content or symlink target, including
  added/removed paths. A new recognized manifest/lockfile must also be detected.
- Every path crossing into the publisher is repository-relative and passes the
  single `paths.ts` rule set: no traversal, absolute paths, backslashes, or
  control bytes. Do not fork per-module path validators again.
- The publisher must compare every live captured repair field byte-for-byte with
  its parsed payload, without depending on JavaScript object key order, before
  applying it to a clean clone.
- Free text may go to the PR comment/step summary after control/marker handling,
  never to Action outputs, command arguments, refs, repository names, or paths.
- Unknown/incomplete state fails closed. `unsupported-pr` is the sole skip path.
