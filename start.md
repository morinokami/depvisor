# Set Up depvisor in a Repository

You are helping the user add depvisor to their repository. depvisor is a GitHub
Action whose AI agent investigates dependency updates, applies them, fixes any
breakage they cause, verifies with the repository's own checks, and opens an
explained PR — a Dependabot/Renovate-style updater that also does the
code-fixing work. It is BYOK (the user pays for LLM calls with their own API
key) and never merges anything itself.

The finished setup is small: **one workflow file, one repository secret, and
one repository setting**. Your job is to inspect the repository first, tailor
the workflow to what you find, and hand the user only the steps you cannot
perform. This file is self-contained — you do not need to fetch anything else.
The README (https://github.com/morinokami/depvisor#readme) documents every
input, output, and status in depth if the user asks for more.

## Step 1: Inspect the repository

Use your filesystem tools on the repository being set up (if the current
directory is not a repository, ask the user which one they mean). Determine
all of the following before writing anything:

1. **Package manager** — from lockfiles and the `packageManager` field in
   package.json:
   - `package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `bun.lock` or
     `bun.lockb` → bun. All three are supported, including their workspace
     monorepos; pnpm's `catalog:`-pinned dependencies are supported too
     (bun's package.json catalogs are not yet).
   - `yarn.lock` → **stop**: depvisor does not support yarn. Tell the user and
     do not set anything up.
   - Lockfiles of several package managers at once: the `packageManager` field
     decides; without it depvisor stops with `ambiguous-package-manager`.
     Resolve the ambiguity with the user (usually by deleting the stale
     lockfile) before continuing.
2. **Committed lockfile** — check with `git ls-files`, not just the
   filesystem:
   - npm/pnpm without a committed lockfile: possible but degraded — the
     `install_command` input must be set to a command that does not create one
     (a bare `npm install` would dirty the tree), and multi-group runs (the
     norm: every package is its own group and `open_pull_requests_limit` defaults to 5)
     lose the reinstall between dependency groups.
     Recommend committing a lockfile instead.
   - bun without a committed lockfile: **stop** — bun computes updates from
     the committed lockfile, so depvisor cannot update the repository at all.
3. **Verification scripts** — depvisor refuses to open a PR it cannot verify:
   - If package.json defines at least one of `build` / `lint` / `test`, those
     are auto-detected and no configuration is needed. depvisor runs them in
     the fixed order **build → lint → test** — build first because tests may
     consume its artifacts (e.g. a test that requires `dist/`).
   - Otherwise, ask the user which commands verify this repository (e.g.
     `npm run check`) and set them as the `verify_commands` input, listed in
     dependency order — a build before the tests that consume its output,
     since the commands run in the order given. Do not invent commands —
     without real ones the run fails with `no-verify-scripts`.
   - Workspace monorepos: verification must run from the repository root and
     exercise the workspaces (root scripts fanning out via `--workspaces`,
     turbo/nx, `bun run --filter`, …). If the root scripts do not reach the
     workspaces, set `verify_commands` to commands that do.
4. **.gitignore** — must cover `node_modules/` and build output; depvisor
   refuses to run on a dirty tree. If installing or building writes files git
   does not ignore, extend `.gitignore` as part of this setup.
5. **Private-registry packages** — look for dependencies that are not on
   registry.npmjs.org (e.g. internal scoped packages behind an `.npmrc`
   registry override). depvisor's supply-chain cooldown checks publish ages
   against the public npm registry and fails closed, so each private package
   must be listed under `minimum_release_age_exclude` — otherwise every run
   goes red with `release-age-unavailable`.

## Step 2: Discover requirements

Ask the user only for what the inspection could not answer. If they already
made a choice in the conversation, treat it as binding.

1. **LLM provider and model** (required):
   - Suggested specifiers: `openai/gpt-5.5`, `anthropic/claude-sonnet-5`.
     OpenRouter works too (`openrouter/<vendor>/<model>`); any other provider
     additionally needs the `llm_api_key_env` input set to the environment
     variable name that provider's SDK expects.
   - The provider determines the API-endpoint host the workflow allows:
     openai → `api.openai.com`, anthropic → `api.anthropic.com`,
     openrouter → `openrouter.ai`.
   - **Secret name**: check `gh secret list` for an existing secret that
     plausibly holds the chosen provider's key (`OPENAI_API_KEY`,
     `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …). You cannot read secret
     values, so never assume — ask the user whether it is that provider's API
     key, and only on their confirmation reference it from the workflow
     instead of creating a new one. No match, no confirmation, or
     `gh secret list` fails (unauthenticated `gh`, insufficient access):
     default to `LLM_API_KEY`.
2. **Schedule** — when should depvisor run? Default to weekly (e.g. Monday
   03:00 UTC) if the user has no preference; `workflow_dispatch` is always
   included for manual runs.
3. **CI on depvisor's PRs** — PRs opened with the default `GITHUB_TOKEN` do
   not trigger the repository's other workflows (GitHub's recursion guard).
   If the user wants their CI checks to run on depvisor's PRs, they must
   provide a GitHub App or PAT token via the `github_token` input; otherwise
   omit it.
4. **Optional inputs** — keep the defaults unless the user asks:
   `open_pull_requests_limit` (default: at most 5 open depvisor PRs; every PR updates
   exactly one package), `minimum_release_age`
   (default: 1-day supply-chain cooldown — keep it enabled), `ignore`
   (packages never to update), `suggest_features` (default off — set `"true"`
   to add a display-only "new features that may be relevant" section to PRs;
   costs extra tokens and widens the agent's exposure to untrusted release
   notes, so leave off unless the user asks).

Before implementing, restate the choices to yourself as a contract:

- Package manager: `<npm | pnpm | bun>`
- Verification: `auto-detected (<scripts>)` or `verify_commands: <commands>`
- Model: `<exact specifier>` → secret `<LLM_API_KEY | confirmed existing name>`, endpoint `<host>`
- Schedule: `<cron>`
- Extras: `<none | github_token | minimum_release_age_exclude | install_command | …>`

## Step 3: Write the workflow

Create `.github/workflows/depvisor.yml` from this template (if a file with
that name already exists, show the user a diff and ask before overwriting):

```yaml
name: depvisor
on:
  schedule:
    - cron: "0 3 * * 1" # ← the user's chosen schedule
  workflow_dispatch: {}

permissions:
  contents: write # push the update branch
  pull-requests: write # open the PR (and create/apply its labels)

concurrency:
  group: depvisor # runs must not race on force-push
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # Recommended: block unexpected network egress.
      - uses: step-security/harden-runner@v2
        with:
          egress-policy: block
          allowed-endpoints: >
            github.com:443
            api.github.com:443
            codeload.github.com:443
            objects.githubusercontent.com:443
            *.actions.githubusercontent.com:443
            registry.npmjs.org:443
            api.osv.dev:443
            api.openai.com:443

      - uses: actions/checkout@v7
        with:
          persist-credentials: false # required — depvisor refuses persisted tokens

      - uses: morinokami/depvisor@v1 # or pin a commit SHA for production (immutable; the recommended pin)
        with:
          llm_api_key: ${{ secrets.LLM_API_KEY }} # ← the Step 2 secret name
          llm_model: openai/gpt-5.5 # ← the user's chosen model
```

Tailor it per the Step 2 contract:

- **Egress allowlist**: replace `api.openai.com:443` with the chosen
  provider's host, and add any private package registries the repository
  installs from. If the verification commands need further endpoints you
  cannot predict, start with `egress-policy: audit` and tighten to `block`
  after a green run — a first run red from blocked egress is confusing.
- **verify_commands** (only when scripts are not auto-detectable):

  ```yaml
  verify_commands: |
    npm run check
  ```

- **minimum_release_age_exclude** (only when Step 1 found private packages):

  ```yaml
  minimum_release_age_exclude: |
    # private packages — not on registry.npmjs.org
    @acme/design-tokens
  ```

  Exact package names only, one per line (full-line `#` comments allowed).
  Globs, version ranges, and majors are not supported — a pattern like
  `@acme/*` must be expanded into one line per package. (pnpm's similarly
  named `minimumReleaseAgeExclude` does accept globs; this input does not, so
  a list carried over from `pnpm-workspace.yaml` may need expanding.)

- **bun repositories**: insert before the depvisor step, pinning
  `bun-version` (depvisor parses `bun outdated`'s text output, so an unpinned
  bun that drifts with releases is a breakage risk — pin the version the
  repository already uses):

  ```yaml
  - uses: oven-sh/setup-bun@v2
    with:
      bun-version: "1.3.14" # ← match the repo's bun version
  ```

- **Do not** remove `persist-credentials: false`, the `permissions` block, or
  the `concurrency` group. depvisor keeps GitHub tokens away from its AI agent
  and from the target's install scripts; it fails at startup if the checkout
  persists credentials.

## Step 4: Hand the human-only steps to the user

Before asking the user to do anything, check what already exists. Both checks
are best-effort — they need an authenticated `gh` with access to the repo, and
when one fails you simply ask the user instead:

```sh
gh secret list # is the Step 2 secret already there?
gh api repos/{owner}/{repo}/actions/permissions/workflow \
  --jq .can_approve_pull_request_reviews # true → item 2 below is already done
```

Then hand over whatever remains. **Never ask the user to paste the API key
into the chat** — `gh secret set` prompts for the value directly:

1. Create the repository secret (skip when Step 2 confirmed an existing one):

   ```sh
   gh secret set LLM_API_KEY
   ```

   (or Settings → Secrets and variables → Actions → New repository secret),
   with the API key of the provider chosen in Step 2.

2. Enable **"Allow GitHub Actions to create and approve pull requests"**
   (Settings → Actions → General → Workflow permissions) — skip when the
   check above already returned `true`. Without it, PR creation fails with
   `open-pr-failed`.

## Step 5: Verify

1. Run the Step 1 verification commands locally on the base branch, in the
   same order depvisor will: **build → lint → test** for auto-detected
   scripts, the given order for `verify_commands`. Running tests without the
   build they consume produces a spurious failure, not a real baseline
   problem. If a command still fails in the right order, tell the user now:
   depvisor stops with `baseline-red` until the base branch is green.
2. Re-check what you wrote: the checkout sets `persist-credentials: false`;
   the `permissions` block grants `contents: write` and
   `pull-requests: write`; the egress allowlist matches the chosen provider.
3. Once the user confirms the secret and the repository setting, commit the
   workflow (on the default branch, or via the user's usual PR flow), then
   trigger a first run and watch it:

   ```sh
   gh workflow run depvisor.yml && gh run watch
   ```

   A successful first run ends green with either a PR labeled `depvisor` or a
   `no-updates` summary.

Common first-run failures and their fixes:

| Status                    | Fix                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `persisted-credentials`   | Set `persist-credentials: false` on `actions/checkout`.                                                         |
| `no-verify-scripts`       | package.json defines none of `build`/`lint`/`test` — set `verify_commands`.                                     |
| `baseline-red`            | The checks already fail on the base branch; fix the base first.                                                 |
| `dirty-tree`              | An install/build wrote files git does not ignore — extend `.gitignore` or fix `install_command`.                |
| `release-age-unavailable` | A private-registry package the public npm registry cannot vouch for — list it in `minimum_release_age_exclude`. |
| `open-pr-failed`          | Enable "Allow GitHub Actions to create and approve pull requests", and check the `permissions` block.           |

Every other status is documented in the README's status reference:
https://github.com/morinokami/depvisor#status-reference
