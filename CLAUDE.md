# depvisor v2

depvisor is a GitHub composite action that consumes existing Dependabot/Renovate
PRs. It no longer discovers versions, edits dependency state, groups updates, or
owns PR lifecycle. One run reviews one updater PR, repairs it when needed, and
maintains an evidence-grounded comment.

## Commands

Node >= 24 and pnpm are required.

```bash
pnpm test
pnpm run check
actionlint
zizmor --persona=auditor --min-confidence=high .
DEPVISOR_TARGET_REPO="$PWD" DEPVISOR_LLM_MODEL=openai/gpt-5.5 pnpm exec flue run repair
```

## Architecture

`src/prepare.ts` resolves the updater PR and failed workflow jobs with `GH_TOKEN`,
then writes a token-free context and dependency-state snapshot outside the
checkout. `src/workflows/repair.ts` prompts the single `depvisor` agent in Flue's
`local()` sandbox. `src/publish.ts` rechecks the snapshot/current PR head, creates
at most one commit in a fresh clone, pushes to the existing updater branch, and
updates one marker comment. `src/report-status.ts` owns Action outputs and the
step summary.

The agent is intentionally powerful: it has the host checkout, shell, runner
tooling, and network. Its model-directed shell gets Flue's default local env
allowlist, not `GH_TOKEN` or the LLM provider key. This is an autonomous coding
agent threat model, not v1's jailed fixer/digest model.

## Invariants

- The updater owns dependency selection. Freeze every original PR path plus
  recognized manifests/lockfiles before model work. If any frozen path changes,
  appears, disappears, or changes symlink target, publish nothing.
- The agent never commits, pushes, or comments. It leaves working-tree edits and
  structured evidence. The publisher transports those outputs after rechecking.
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
  `env -i` child process; otherwise the agent can taint a later token process via
  runner command files or action-source writes.
- PR text, diffs, CI logs, dependency code, web content, and agent output are
  untrusted. Bound logs/context, validate structured handoffs, and never place
  free text in Action outputs or shell interpolation.
- The external CI workflow remains the merge authority. Agent-reported command
  evidence is reviewer information, not a security attestation.

## Documentation ownership

- `README.md` and `start.md`: complete consumer workflow and two-input minimum.
- `docs/configuration.md`: inputs, workflow requirements, agent authority.
- `docs/results.md`: outputs and status vocabulary.
- `src/core/CLAUDE.md`: deterministic publication boundary.
- `src/CLAUDE.md`: Flue/entrypoint capability map.
- `.agents/skills/depvisor-update-flow/SKILL.md`: end-to-end per-PR flow.
- `.agents/skills/depvisor-release/SKILL.md`: Action/CI/release distribution.

Whenever behavior changes, update the owning reference in the same change.

## Gotchas

- `workflow_run` is deliberate: it starts after CI and makes secrets available
  from a default-branch workflow even for Dependabot PRs. The consumer must check
  out `github.event.workflow_run.head_sha`, not the default branch.
- A repair push triggers CI and then depvisor again. The second green pass should
  update the same marker comment and make no new commit unless more repair is
  genuinely needed.
- `local()` has no host isolation. Do not describe absence of env vars as an OS
  security boundary. The product explicitly accepts coding-agent-level risk.
- Flue is exact-pinned beta. Use the `flue` skill and bundled `flue docs` rather
  than guessing APIs.
- Composite nested `uses:` cannot evaluate `github.action_path`, and
  pnpm/action-setup mishandles an absolute `package_json_file`; action.yml keeps
  the existing workaround.
