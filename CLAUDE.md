# depvisor v2

depvisor is a GitHub composite action that reviews and repairs existing
Dependabot/Renovate PRs. Version discovery, dependency-state edits, update
grouping, and PR lifecycle belong to the updater — never to depvisor. One run
reviews one updater PR, repairs it when needed, and maintains an evidence-based
comment.

## Commands

Node >= 24 and pnpm are required.

```bash
pnpm test
pnpm run check
actionlint
zizmor --persona=auditor .
```

A local `flue run repair` needs a context prepared by `prepare.ts` for a real
updater PR; the `depvisor-update-flow` skill documents the exact sequence.

## Architecture

One pipeline: `prepare.ts` (GH_TOKEN, read-only PR/CI snapshot) → single
`depvisor` agent in Flue's `local()` sandbox (no GitHub token) → `publish.ts`
(GH_TOKEN, fresh-clone publication of the captured repair and report) →
`report-status.ts` (Action outputs). `src/CLAUDE.md` maps entrypoints and
credentials; `src/core/CLAUDE.md` owns the deterministic publication boundary.

Security model, stated once: the agent is intentionally powerful — host
checkout, shell, runner tooling, and network. Env filtering keeps `GH_TOKEN`
and the provider key out of its shell, and source hashing plus env scrubbing
harden the later token-holding steps, but none of this is OS isolation. The
agent and token-holding steps share a job and UID; a lingering background
process, runner-writable executable/PATH entry, tampered `runner.temp` status
file, or malicious target install script stays in scope. This is an accepted,
user-documented coding-agent risk until publication moves to an isolated job on
a fresh runner.

## Invariants

- The updater owns dependency selection. Freeze every original PR path plus
  recognized manifests/lockfiles before the agent runs. If any frozen path
  changes, appears, disappears, or changes symlink target, publish nothing.
- The agent never commits, pushes, or comments. It leaves working-tree edits and
  structured evidence. The publisher pushes and posts those outputs after
  rechecking.
- Refuse a changed HEAD. The publisher also requires the PR to remain open at the
  snapshotted SHA and pushes with `--force-with-lease`.
- Only open same-repository PRs from Dependabot/Renovate are supported. Never push
  to a fork or a model-selected repository/ref/PR number.
- The target checkout must use `persist-credentials: false`; keep the repo-local
  credential detector before the agent.
- Publication runs from a fresh clone with clean HOME/git configuration. Never
  push from the agent-visible checkout's `.git`.
- Snapshot every `src/` file before `local()` and verify that digest in the
  publisher/reporter steps. Keep their explicit shell/loader env scrubbing and
  `env -i` child process as file/environment hardening.
- PR text, diffs, CI logs, dependency code, web content, and agent output are
  untrusted. Bound logs/context, validate structured handoffs, and never place
  free text in Action outputs or shell interpolation.
- The external CI workflow remains the merge gate. Agent-reported command
  evidence is reviewer information, not a security attestation.

## Documentation ownership

- `README.md` and `start.md`: complete consumer workflow and the minimal
  two-input setup.
- `docs/configuration.md`: inputs, workflow requirements, agent environment.
- `docs/results.md`: outputs and statuses.
- `src/core/CLAUDE.md`: deterministic publication boundary.
- `src/CLAUDE.md`: Flue/entrypoint capability map.
- `.agents/skills/depvisor-update-flow/SKILL.md`: end-to-end per-PR flow.
- `.agents/skills/depvisor-release/SKILL.md`: Action/CI/release distribution.

Whenever behavior changes, update the owning reference in the same change.

## Gotchas

- `workflow_run` is deliberate: it starts after CI and makes secrets available
  from a default-branch workflow even for Dependabot PRs. The consumer must check
  out `github.event.workflow_run.head_sha`, not the default branch.
- A repair push with the default `github_token` does not trigger the next
  depvisor pass on its own: GitHub can gate the repaired head's CI run behind
  manual approval, and it delivers no `workflow_run` event for a CI run
  originally triggered by that token's push (a rerun keeps that original
  trigger). The repair and full report are already published by the first pass.
  A later updater- or human-initiated green run on that head updates the same
  report comment and makes no new commit unless more repair is genuinely
  needed; further green passes on the unchanged head skip with
  `already-reviewed` via the comment's state line.
- Flue is exact-pinned beta. Use the `flue` skill and bundled `flue docs` rather
  than guessing APIs.
- Composite nested `uses:` cannot evaluate `github.action_path`, and
  pnpm/action-setup mishandles an absolute `package_json_file`; action.yml keeps
  the existing workaround.
