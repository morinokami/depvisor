# Set Up depvisor in a Repository

You are helping the user add depvisor to their repository. depvisor is a
GitHub Action that provides **aftercare for dependency-update PRs**: it
consumes the PRs an updater (Dependabot, Renovate, or similar) already opens,
verifies each one with the repository's own checks deterministically, repairs
source/test breakage with a bounded AI fixer when the update caused it, proves
the repair passes, and publishes a repair commit plus a reviewer report
comment on the PR. It never opens PRs, never chooses versions, never edits
dependency state, and never merges anything itself. It is BYOK (the user pays
for LLM calls with their own API key).

Both agent roles run in an in-memory workspace without a host shell. The
digest gets bounded read/search access to the target repository; only the
failure-path fixer gets bounded repo-relative edit tools. Neither can reach
depvisor's action checkout or the later GitHub-token step.

The finished setup is small: **one workflow file and one or two secrets**.
Your job is to inspect the repository first, tailor the workflow to what you
find, and hand the user only the steps you cannot perform. This file is
self-contained — you do not need to fetch anything else. The README
(https://github.com/morinokami/depvisor#readme) and its reference pages
(https://github.com/morinokami/depvisor/tree/main/docs) document every input,
output, and status in depth if the user asks for more.

## Step 1: Inspect the repository

Use your filesystem tools on the repository being set up (if the current
directory is not a repository, ask the user which one they mean). Determine
all of the following before writing anything:

1. **An updater must already be running** — look for `.github/dependabot.yml`
   (Dependabot) or `renovate.json`/`.github/renovate.json5`/a Renovate app
   (Renovate). depvisor only consumes updater PRs; without an updater there is
   nothing for it to do. If none exists, offer to set up Dependabot first (a
   minimal `.github/dependabot.yml` with `package-ecosystem: npm` is enough)
   and note which bot login the workflow must filter on:
   - Dependabot → `dependabot[bot]`
   - Renovate (GitHub App) → `renovate[bot]` (self-hosted setups may use a
     custom bot account — ask the user).
2. **Package manager** — from lockfiles and the `packageManager` field in
   package.json:
   - `package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `bun.lock` or
     `bun.lockb` → bun. All three are supported, including their workspace
     monorepos and pnpm's `catalog:`-pinned dependencies.
   - `yarn.lock` → **stop**: depvisor does not support yarn. Tell the user and
     do not set anything up.
   - Lockfiles of several package managers at once: the `packageManager` field
     decides; without it depvisor stops with `ambiguous-package-manager`.
     Resolve the ambiguity with the user before continuing.
3. **Committed lockfile** — check with `git ls-files`, not just the
   filesystem. depvisor's failure attribution reinstalls dependencies at the
   PR's merge base and head, which needs a committed lockfile. No lockfile →
   recommend committing one before setup.
4. **Verification scripts** — read package.json `scripts`. depvisor
   auto-detects `build`, `lint`, and `test` (in that order; `typecheck` is
   deliberately not auto-detected). If the repository's real checks go by
   other names (`typecheck`, `check`, `ci`, workspace fan-outs), plan an
   explicit `verify_commands` input listing them one per line. These checks
   must pass on the default branch — depvisor stops with `baseline-red` when
   the base itself is broken.
5. **`.gitignore`** — must cover `node_modules/` and build output; depvisor
   refuses dirty trees.
6. **LLM provider** — ask the user which provider/model to use
   (e.g. `openai/gpt-5.5`, `anthropic/claude-sonnet-5`). The key becomes a
   secret; never write it into a file.

## Step 2: Write the workflow

Create `.github/workflows/depvisor.yml`. Template — adjust the actor filter,
model, and `verify_commands` to what you found:

```yaml
name: depvisor
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions: {}

concurrency:
  group: depvisor-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  aftercare:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write # push the repair commit onto the PR head branch
      pull-requests: write # create/update the report comment
    steps:
      - uses: actions/checkout@v7
        with:
          # The PR head branch itself (not the merge ref): the repair commit
          # is published onto it. fetch-depth: 0 so the merge base with the
          # base branch is computable.
          ref: ${{ github.event.pull_request.head.ref }}
          fetch-depth: 0
          persist-credentials: false # required — depvisor refuses persisted tokens

      - uses: morinokami/depvisor@v2
        with:
          llm_api_key: ${{ secrets.LLM_API_KEY }}
          llm_model: openai/gpt-5.5
          # verify_commands: |            # only when auto-detection is wrong
          #   npm run typecheck
          #   npm run test
```

Tailoring rules:

- **bun repos**: add `oven-sh/setup-bun` (with a pinned `bun-version`) before
  the depvisor step.
- **Custom install**: if installing needs flags or a different tool, set
  `install_command`; if an earlier step in the same job already installed,
  set `install_command: skip`.
- **Localized reports**: `language: ja` (BCP-47 tag) localizes only the
  LLM-written narrative in the report comment.
- **Renovate**: change the `if:` login accordingly, and consider both bots
  with `contains(fromJSON('["dependabot[bot]","renovate[bot]"]'),
github.event.pull_request.user.login)`.

## Step 3: Secrets and settings (the user does these)

Tell the user, concretely:

1. **Add the LLM API key secret** — Settings → Secrets and variables →
   Actions → New repository secret, name `LLM_API_KEY`.
2. **Dependabot only**: add the SAME secret again under Settings → Secrets
   and variables → **Dependabot** — workflows triggered by Dependabot PRs read
   the Dependabot secrets store, not the Actions one. (The job-level
   `permissions:` block in the workflow elevates Dependabot's default
   read-only token; no extra setting is needed for that.)
3. Optional: if they want their CI to re-run on depvisor's repair commits,
   they need a GitHub App or PAT passed as `github_token` — pushes made with
   the default `GITHUB_TOKEN` do not trigger other workflows.

## Step 4: Explain what will happen

On each updater PR, depvisor ends in exactly one status (the job fails on red
so nothing is silent):

- `report-prepared` (green): the update verifies clean as-is; a reviewer
  report comment was posted/updated.
- `repair-prepared` (green): the update broke verification, the merge base
  verified green, and a bounded `fix: adapt code to <package> update` commit
  (source and tests only, committed by `depvisor[bot]`) was pushed to the PR
  with the report.
- `not-an-update-pr` (green): the PR carries human commits or no dependency
  change; skipped.
- `deferred` (green): the fixer judged the repair unsafe to make (e.g. it
  would need a manifest change); the report explains — a human should take
  over.
- `publish-blocked` (green): the PR merged/closed or its head moved mid-run;
  nothing was pushed; the next PR event re-runs.
- `verification-failed` (red): no passing repair could be produced; the
  report explains what is broken.
- `baseline-red` (red): the base itself fails the checks — fix the base
  first.
- Setup-shaped reds worth knowing: `persisted-credentials` (checkout kept its
  token), `missing-base-ref` (checkout too shallow — needs `fetch-depth: 0`),
  `no-verify-scripts` (no checks found — set `verify_commands`),
  `unsupported-package-manager` / `ambiguous-package-manager`,
  `reinstall-unavailable` (no committed lockfile with
  `install_command: skip`).

The full status and outputs reference:
https://github.com/morinokami/depvisor/blob/main/docs/results.md

## Step 5: Verify the setup

Ask the user to wait for (or trigger) the next updater PR — Dependabot:
Insights → Dependency graph → Dependabot → "Check for updates", or just
re-open an existing Dependabot PR to fire the workflow. Then check:

- the depvisor job ran and ended green with `report-prepared` or
  `repair-prepared`;
- the PR carries one "depvisor aftercare" comment;
- when a repair happened, the PR gained a `fix: adapt code to …` commit and
  the checks pass with it.
