# Configuring depvisor

This page documents depvisor's repository requirements and every
behavior-shaping input in depth. The quick-start workflow and the inputs table
live in the [README](../README.md); each input's default is declared in
[`action.yml`](../action.yml).

depvisor is aftercare: it consumes PRs an updater (Dependabot, Renovate, …)
already opened. Everything about _which_ updates happen — discovery, version
selection, grouping, cooldowns, ignore rules, schedules, PR limits — is the
updater's configuration, not depvisor's. If you are looking for v1's `groups`,
`ignore`, `minimum_release_age`, or `open_pull_requests_limit` inputs: they
were removed in v2; configure the equivalent in Dependabot
(`groups`/`ignore`/`cooldown`/`open-pull-requests-limit`) or Renovate
(`packageRules`/`minimumReleaseAge`/`prConcurrentLimit`).

## The two-job pipeline

depvisor runs once per updater PR head, from a `pull_request` workflow with
TWO jobs — the split is the token-separation boundary, not an implementation
detail:

- **analyze** (`morinokami/depvisor@v2`, token-free): checks out the PR head,
  runs the target's own install/verify scripts, repairs, and uploads the
  result as a workflow artifact. Target scripts can taint this runner's files
  (`$GITHUB_PATH`, `$GITHUB_ENV`, `BASH_ENV`), so nothing token-holding may
  ever run on it — the job needs only `contents: read` (for the checkout).
  The LLM key lives here, and even it is scrubbed from the environment of
  every target subprocess (installs, verification commands).
- **publish** (`morinokami/depvisor/publish@v2`, token-holding): a fresh
  runner that never executed target code. It downloads the artifact
  (untrusted data — the repair range is re-verified structurally and the
  comment re-sanitized), fast-forward-pushes the repair, and upserts the
  report comment. Needs `contents: write` and `pull-requests: write`, no
  checkout at all. Gate it with `needs: analyze` and `if: ${{ !cancelled()
&& needs.analyze.result != 'cancelled' && needs.analyze.result != 'skipped'
}}` — it must run even when analyze went red, because a
  `verification-failed` report comment is exactly what the reviewer needs.

Workflow-shaping details:

- **Events**: `types: [opened, synchronize, reopened]`. Every new head sha
  gets one analysis; the report comment is updated in place, never stacked.
- **Actor filter**: gate the analyze job on the updater's login
  (`github.event.pull_request.user.login == 'dependabot[bot]'`, add
  `renovate[bot]` or your bot account as needed). depvisor additionally
  refuses PRs whose commits touch non-dependency paths (`not-an-update-pr`),
  but the actor filter keeps it from spending any compute on human PRs.
- **Checkout** (analyze job only): the PR's **head branch** by name
  (`ref: ${{ github.event.pull_request.head.ref }}`) — the repair commit is
  published onto it — with `fetch-depth: 0` (the merge base with the base
  branch must be computable) and `persist-credentials: false` (depvisor
  fail-closes on persisted credentials; the analyze job must never sit next
  to a token).
- **Concurrency**: group per PR number with `cancel-in-progress: true` — a new
  push to the PR obsoletes the running analysis, and depvisor's
  compare-and-swap publish makes the stale run harmless anyway.

### Dependabot-triggered workflows

Two GitHub platform rules matter when the PR author is Dependabot:

- Secrets come from the **Dependabot secrets** store (Settings → Secrets and
  variables → Dependabot), not the Actions store. Register your LLM API key in
  both places if other workflows also need it.
- The default `GITHUB_TOKEN` is read-only for Dependabot-triggered runs; the
  publish job's `permissions:` block elevates it.

Renovate (as a GitHub App or bot user) triggers ordinary `pull_request` runs
with ordinary secrets.

### CI on repaired PRs

Pushes made with the default `GITHUB_TOKEN` do not trigger other workflows
(GitHub's recursion guard), so a depvisor repair commit does not re-run your
CI on the PR by itself. If you want CI to re-run on repaired heads, pass a
GitHub App or PAT token as `github_token`.

## Repository requirements

- **Package manager**: npm, pnpm, or bun. The `packageManager` field wins
  detection when present; otherwise the lockfile decides; multiple PMs'
  lockfiles without a `packageManager` field fail closed
  (`ambiguous-package-manager`). yarn is not supported
  (`unsupported-package-manager`).
- **Lockfile**: commit one. The baseline attribution (verify the merge base
  under _its_ dependency state, then return to the head under _its_ state)
  needs a lockfile-faithful reinstall on both sides. With
  `install_command: skip` and no lockfile, a red head stops with
  `reinstall-unavailable`.
- **bun repos** additionally need the bun binary on the runner — GitHub-hosted
  runners do not preinstall it, so add
  [`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun) before the
  depvisor step and pin `bun-version`. The legacy binary `bun.lockb` works for
  detection and installs, but the dependency diff cannot read it — the report
  then falls back to manifest specifiers — so the text `bun.lock` is
  recommended (`bun install --save-text-lockfile --frozen-lockfile
--lockfile-only` migrates).
- **[nub](https://nubjs.com) (nubjs) repos** work through depvisor's pnpm
  support: nub round-trips `pnpm-lock.yaml` and keeps
  `packageManager: "pnpm@…"`, so detection resolves to pnpm. Add
  [`nubjs/setup-nub`](https://github.com/nubjs/setup-nub) when your scripts
  wrap `nub run`, and set `install_command: nub install --frozen-lockfile`
  (reused verbatim for the attribution reinstalls).
- **Workspaces/monorepos** are supported for all three PMs. The dependency
  diff enumerates every workspace manifest, resolves pnpm `catalog:`
  references through `pnpm-workspace.yaml`, and reports which workspaces
  declare each changed package.
- **Verification must exist and pass on the base.** package.json must define
  at least one of `build`/`lint`/`test`, or `verify_commands` must name your
  checks. A base that fails its own checks stops the run (`baseline-red`):
  a repair on a broken base could not be attributed to the update.
- `.gitignore` must cover `node_modules/` and build output; depvisor refuses
  dirty trees and treats unexpected tracked/untracked changes as scope
  violations.

## Inputs

### `llm_api_key`, `llm_model`, `llm_api_key_env`

Required. depvisor is BYOK and provider-agnostic through
[Flue](https://flue.dev)'s model catalog: `llm_model` is
`provider/model-id` (e.g. `openai/gpt-5.5`, `anthropic/claude-sonnet-5`,
`openrouter/…`). For the known providers the key's env var is inferred; for
anything else set `llm_api_key_env` to the variable name the provider SDK
expects. The key is exposed **only** to the analyze job, which never holds a
GitHub token — and target subprocesses (installs, verification commands) get
it scrubbed from their environment, so the packages under test never see it
either.

The fixer runs only when verification fails and the baseline is green; the
digest runs once per analyzed PR. Both are bounded (jailed repo tools, capped
release-notes injection), and the step summary reports tokens and an estimated
cost per run.

### `github_token` (publish action)

An input of `morinokami/depvisor/publish@v2`, not of the analyze action: the
fast-forward push of the repair commit and the report comment. Defaults to
the workflow's `GITHUB_TOKEN`. Needs `contents: write` and
`pull-requests: write` on the PR's repository.

### `artifact_name` (both actions)

The workflow artifact that carries the payload (report comment + optional
repair bundle) from analyze to publish. Defaults to `depvisor-aftercare`;
set it on BOTH actions if you need another name (e.g. matrix runs).

### `pr_number`, `base_ref`, `head_ref`

The PR identity. All three default from the `pull_request` event context, so
you normally never set them. They are validated fail-closed (`bad-pr-number`,
`bad-base-ref`, `bad-head-ref`) and are re-supplied to the token-holding
publish step from the trusted event context — never from files the agent step
wrote. Local/dev runs set them via `DEPVISOR_PR_NUMBER`, `DEPVISOR_BASE_REF`,
`DEPVISOR_HEAD_REF` (head falls back to the checked-out branch).

### `install_command`

How the target's dependencies get installed before verification:

- `auto` (default): the detected PM's lockfile-faithful install (`npm ci`,
  `pnpm install --frozen-lockfile`, `bun install --frozen-lockfile`).
- `skip`: you installed them in an earlier workflow step. Skips only the
  pre-agent install; the baseline/head attribution reinstalls still use the
  PM's frozen install (which needs a committed lockfile).
- Anything else: run verbatim (trusted — it comes from your workflow file),
  and reused verbatim for the attribution reinstalls.

### `verify_commands`

Newline-separated shell commands that **replace** script auto-detection
entirely. When empty, depvisor runs the package.json scripts it finds among
`build` → `lint` → `test`, in that order (`typecheck` is deliberately not
auto-detected — name it here if you want it). The verification gate is the
product's spine: what it cannot vouch for is not published
(`no-verify-scripts`). The value must come from your workflow file; depvisor
never reads verification commands from the target tree.

### `language`

A restricted BCP-47-style tag (`ja`, `pt-BR`, `zh-Hant`) for the LLM-written
narrative text in the report comment. Deterministic strings — statuses, the
repair commit message, section headings, the verdict line — stay English:
they are machine contracts. Empty means English. Anything outside the strict
tag grammar fails closed (`bad-language`) rather than becoming a free-form
prompt input.

### `node_version`

The Node version for depvisor itself and your verification scripts. Must be

> = 24 (depvisor's `engines` floor). If your repository needs a different
> runtime matrix, run depvisor with the Node your default verification expects.

## What depvisor never does (v2)

- Open, close, retitle, rebase, or label PRs. The updater owns the PR.
- Choose versions or edit dependency state: no manifest, lockfile, or
  `pnpm-workspace.yaml` change ever comes from depvisor — the scope gates
  reject them from the fixer, and the publish boundary re-verifies the pushed
  range.
- Force-push or overwrite: the repair push is fast-forward-only and only lands
  while the remote head is exactly the commit that was analyzed.
- Build repairs on human work: any commit in the PR beyond dependency state
  (other than depvisor's own previous repairs) skips the PR
  (`not-an-update-pr`).
