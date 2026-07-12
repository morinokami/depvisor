# Configuring depvisor

This page documents depvisor's repository requirements and every
behavior-shaping input in depth. The quick-start workflow and the inputs table
live in the [README](../README.md); each input's default is declared in
[`action.yml`](../action.yml).

## Repository requirements

The quick-start essentials are listed in the
[README's prerequisites](../README.md#prerequisites); this section covers the
finer points.

- **Lockfiles**: depvisor expects a committed lockfile. For npm/pnpm, a repo that
  tracks no lockfile can still run by setting `install_command` explicitly to a command
  that does not create one. bun has no such escape hatch — it computes updates from the
  committed lockfile, not the installed tree, so a bun repo must commit `bun.lock` (or
  `bun.lockb`) to be updatable at all. Multi-group runs (the norm) also need a
  committed lockfile for the reinstall between dependency groups — see
  [One PR per package](#one-pr-per-package-open_pull_requests_limit).
- **bun repos** additionally need the bun binary on the runner — GitHub-hosted runners
  do not preinstall it, so add [`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun)
  before the depvisor step, and pin `bun-version`: depvisor parses `bun outdated`'s
  table output (bun has no JSON mode), so an unpinned bun that drifts with releases is
  a breakage risk. The legacy binary `bun.lockb` works, but the text `bun.lock` keeps
  lockfile diffs reviewable (`bun install --save-text-lockfile --frozen-lockfile
--lockfile-only` migrates).
- **[nub](https://nubjs.com) (nubjs) repos** work through depvisor's pnpm support.
  nub is pnpm-compatible — it round-trips `pnpm-lock.yaml` and keeps
  `packageManager: "pnpm@…"` in package.json — so depvisor detects such a repo
  as pnpm and drives the deterministic bump with its own pinned pnpm; nub's
  lockfile round-trip keeps that coherent. The one thing missing on the runner
  is the `nub` binary itself, which matters when your package.json scripts wrap
  `nub run` (they would otherwise fail during verification). The recipe:
  add [`nubjs/setup-nub`](https://github.com/nubjs/setup-nub) before the
  depvisor step (as with bun's `setup-bun`), and set
  `install_command: nub install --frozen-lockfile` (reused verbatim for the
  between-groups reinstall). Verification still launches scripts via
  `pnpm run <script>` — pnpm may re-materialize a nub-installed `node_modules`
  into its own layout first, which is harmless because the shared lockfile pins
  identical versions — and their `nub run …` bodies find nub on `PATH` and just
  work. First-class support (`nub outdated`, `nub run` as the verify prefix) is
  deliberately not offered: nub has no unique on-disk marker to detect, and its
  `outdated --json` output is undocumented and (as of nub v0.4.7, which this
  recipe was verified against) lacks the per-workspace `dependentPackages`
  attribution depvisor's collector needs — see
  [#40](https://github.com/morinokami/depvisor/issues/40).
- **Workspace monorepos** (npm, pnpm, and bun `workspaces`) are supported: depvisor
  updates each dependency in the workspace(s) that already declare it, never the
  root. This needs the single shared lockfile at the repo root, and verification
  that runs from the root — a root `build`/`lint`/`test` script that exercises the
  workspaces (e.g. via `turbo`/`nx`, `--workspaces`, or `bun run --filter`), or
  explicit `verify_commands`. For bun, workspace `workspaces` globs must be a
  literal directory or a single-level `dir/*` (deeper globs fail closed). yarn
  workspaces are not supported.
- **pnpm catalogs are supported**: a dependency pinned via the `catalog:` protocol
  is updated by moving its entry in `pnpm-workspace.yaml`'s `catalog`/`catalogs`
  section to the target version. depvisor makes that edit deterministically — a
  comment-preserving YAML rewrite of exactly the entries being updated, before any
  AI is involved and never by the agent — and leaves the `catalog:` specifier in
  package.json in place. While the `minimum_release_age` cooldown is active, catalog
  entries are written as exact versions (like bun's pins) so a later install cannot
  resolve a range back into the cooldown window. bun's package.json catalogs are not
  supported yet. (If one package is pinned inconsistently — a `catalog:` reference in
  one workspace but a plain version in another — depvisor cannot update it safely and
  stops that group with `bump-failed`; unify the declarations.)

## Verification commands (`verify_commands`)

depvisor refuses to open a PR it cannot verify: when no verification gate can
run, the run stops with `no-verify-scripts` and no PR is opened, by design.

Verify steps come from script auto-detection — package.json's `build` / `lint` /
`test`, run in that fixed order (build first, because tests may consume its
artifacts) — or from the `verify_commands` input (newline-separated shell
commands), which **replaces** auto-detection entirely and runs in the order
given:

```yaml
# e.g. when your checks go by other names:
verify_commands: |
  npm run check
  npm run test:unit
```

Details worth knowing:

- **The base branch must be green**: the same gate runs on the base tip before
  any update is applied, so a post-update failure is always attributable to the
  update itself. A base that already fails stops the run with `baseline-red`.
- **Trusted config only**: `verify_commands` is read from the workflow file,
  never from the (agent-writable) target repository.

## Update cooldown (`minimum_release_age`)

Freshly published versions are the main carrier of supply-chain attacks: a
compromised release is published, and automatic updaters spread it within hours.
depvisor therefore refuses to update to a version younger than
`minimum_release_age` days (default `1` day).
This is enforced deterministically from the npm registry's publish timestamps,
before any AI is involved. If a dependency's latest version is too new, depvisor
updates to the newest version that **has** aged enough instead, and holds the
dependency back entirely when nothing newer than the installed version has —
the run summary lists every clamp and hold-back.

Details worth knowing:

- **Fail-closed**: when the npm registry cannot vouch for a version's age
  (network failure, or a package that does not exist on registry.npmjs.org —
  e.g. a private-registry package), that update is skipped and the job is
  marked red (`release-age-unavailable`). A transient failure heals on the
  next scheduled run. If your repo uses private packages, list them in
  `minimum_release_age_exclude` (next bullet) so the cooldown keeps defending
  everything else.
- **Private packages: exempt them per package, don't disable the defense**
  (`minimum_release_age_exclude`): newline-separated package names (full-line
  `#` comments allowed) skip the age check and update straight to the version
  the collector reports — the same escape hatch pnpm ships as
  `minimumReleaseAgeExclude`.

  ```yaml
  minimum_release_age_exclude: |
    # our private packages — not on registry.npmjs.org
    @acme/design-tokens
    @acme/eslint-config
  ```

  Every line is an **exact package name or a trailing-`*` prefix glob**
  (`@acme/*` — the natural shape for a private scope, and new `@acme/…`
  packages are covered without editing the workflow). Version ranges, majors
  (`@acme/design-tokens@2`), and any other pattern form (`@acme*`, `?`,
  a `*` anywhere but the end) are **not** supported. A glob only ever matches
  packages the outdated scan actually reported — it never queries a registry.
  (pnpm's `minimumReleaseAgeExclude` accepts richer globs; only the
  trailing-`*` form carries over as-is.)

  The exemption is meant for packages the public registry cannot vouch for.
  Excluding a package that _does_ exist on npmjs removes a real supply-chain
  defense for it — and a glob widens that risk: `@acme/*` exempts **every**
  current and future match, so never use one broader than your private scope.
  Malformed entries
  fail loudly (`bad-minimum-release-age-exclude`); a _misspelled_ name is still a
  valid package name, so it parses, exempts nothing, and the package it was
  meant to exempt keeps failing the run with `release-age-unavailable`. Either
  way a bad entry never silently drops the cooldown — it only ever fails to
  lift it. `minimum_release_age: 0` remains the full disable.

- **bun repos get exact pins while the cooldown is active**: bun resolves
  ranges at install time, so depvisor instructs `bun add <name>@<version>`
  (no `^`) to stop an install from reaching back into the cooldown window.
  Your manifest then carries an exact version instead of a caret range. pnpm
  **catalog entries** get the same treatment for the same reason: a hand-edited
  catalog range is resolved fresh by the follow-up install, so while the
  cooldown is active the entry is written exact.
- **A clamped major can move between PRs as it matures**: while a new major is
  inside the cooldown window, depvisor may open a PR for an older minor (e.g.
  `depvisor/prod-foo`); once the major has aged, the update moves to its own
  `depvisor/major-foo` PR. The earlier PR is not closed automatically — close
  or merge it yourself, since it counts against `open_pull_requests_limit` until you do.
  (Packages in a declared [group](#grouping-packages-groups) are not affected:
  their PR identity is the group's name, so a maturing major just refreshes the
  group's existing PR.)

## Ignoring packages (`ignore`)

Some updates you simply do not want depvisor to keep trying: a major that clashes
with your Node version, a dependency that went commercial, a version you have
intentionally pinned. Without a way to say so, that dependency resurfaces every
scheduled run and burns an agent investigation only to fail or defer again. The
`ignore` input is the permanent, human-decided exclusion (Dependabot's `ignore`):

```yaml
ignore: |
  left-pad
  # v11 needs a newer Node; revisit after our runtime upgrade
  lru-cache@11
  # our forked plugins are managed out-of-band
  @acme-forks/*
```

(`left-pad` is never updated; `lru-cache` keeps updating, just not to the `11.x`
major; anything under `@acme-forks/` is never updated. Full-line `#` comments
are allowed — use them to record _why_ a package is ignored; anything else must
parse as `name`, `name@<major>`, or a trailing-`*` prefix glob.)

Details worth knowing:

- **Deterministic and pre-agent**: ignored packages are dropped right after the
  outdated scan — before the cooldown, grouping, and any AI — so they cost no
  LLM call.
- **Trusted config only**: like `verify_commands`, `ignore` is read from the
  workflow file, never from the (agent-writable) target repository.
- **Prefix globs match silently-growing sets — the run summary shows what they
  hit**: a glob rule (`@types/*`, `eslint-*`) drops every candidate whose name
  starts with the stem, including packages added to the repo after the rule was
  written. Because ignoring is where over-matching hurts most (updates just
  stop, silently), every candidate a glob dropped is attributed to its rule in
  the run summary (`@types/react 17.0.0 -> 18.0.0 (via @types/*)`), and a glob
  that matched nothing this run is reported too (`@nope/* matched no outdated
candidate`) — matching zero is normal, but it is also how a typo'd stem
  surfaces, the glob counterpart of the misspelled-exact-name trap. A glob
  cannot take a major suffix — `@acme/*@3` fails with `bad-ignore`.
- **Ordering vs the cooldown**: `name@<major>` matches the registry's latest
  major. If `minimum_release_age` would clamp that major down to an older one
  anyway, the update was never going to that major, so the rule conservatively
  drops it a run early rather than letting it slip through.
- **Existing PRs are left alone**: adding a package to `ignore` does not close a
  PR depvisor already opened for it — close or merge it yourself, since it
  counts against `open_pull_requests_limit` until you do.
- **Typos fail loudly**: an unrecognized entry stops the run with `bad-ignore`
  rather than silently ignoring nothing.

## Grouping packages (`groups`)

Some packages only make sense updated together — `react` and `react-dom` must
move in lockstep, and a lint stack is easier to review as one change. The
`groups` input declares such bundles (Dependabot's `groups`), one group per
line:

```yaml
groups: |
  # react and its type stubs move in lockstep
  react: react react-dom @types/react @types/react-dom
  linting: eslint, eslint-config-prettier
```

Each line is `<group-name>: <package> <package> …` — members separated by
spaces and/or commas, full-line `#` comments allowed. A member is an exact
package name or a trailing-`*` prefix glob (`@acme/*` groups every `@acme/…`
package that has an update). The group name may use
letters, digits, `.`, `_`, and `-`, must start and end with a letter or digit,
and may not contain `..` or end in `.lock` (it becomes part of the branch
name, so it must survive git's ref rules unchanged). When at least one member
has a pending update, the whole group is updated on one branch
(`depvisor/group-<name>`) in one PR; packages in no group keep getting their
own PR per package.

Details worth knowing:

- **Exact names or trailing-`*` prefix globs only**: like `ignore` and
  `minimum_release_age_exclude`, version ranges, majors, and any other pattern
  form (`@acme*`, `?`, a `*` anywhere but the end) are not supported. Any line
  that does not parse stops the run with `bad-groups`. A glob expands against
  the packages the outdated scan reported, so a new `@acme/…` package joins the
  group automatically — and since the branch derives from the group's _name_
  (next bullet), that just refreshes the same PR.
- **The group name is the PR identity**: the branch derives from the declared
  name, never from which members happen to have updates in a given run — so a
  member joining later (a major maturing past the `minimum_release_age`
  cooldown, or simply its first update since you declared the group) refreshes
  the same PR instead of opening a new one. Renaming a group changes its branch
  and strands the old PR — close it yourself.
- **Majors are included**: ungrouped majors are isolated in their own PR for
  individual review, but a declared group takes all of its members' update
  types together — you declared them related, and the react/react-dom case is
  precisely a simultaneous major. The PR's `semver:*` label reflects the
  riskiest member. Group with intent.
- **One group per package**: a package listed in two groups (or twice in one)
  stops the run with `bad-groups` — a precedence rule would make PR identity
  depend on rule order. With globs the check is **static, pattern against
  pattern**: members of different groups that could ever match the same package
  (`@types/react` vs `@types/*`, or `@acme/*` vs `@acme/ui-*`) are rejected at
  parse time, so a config can never be valid one run and `bad-groups` the next
  just because a new package appeared. Within one group, an exact member
  covered by that group's own glob is allowed (redundant, not ambiguous).
- **The group succeeds or fails as a unit**: the deterministic bump, the
  verification gate, and (when needed) the fixer all operate on the whole
  group, so one member's breakage defers or fails the group's PR, not just
  that member.
- **Trusted config only**: like every knob, `groups` is read from the workflow
  file, never from the (agent-writable) target repository.

## One PR per package (`open_pull_requests_limit`)

Every PR updates a single package — or a single declared group (see
[Grouping packages](#grouping-packages-groups)) — so `open_pull_requests_limit` directly controls how many
independent updates can be in flight. It is a ceiling on **open** depvisor PRs
(default `5`, matching Dependabot's `open-pull-requests-limit` default), not a
per-run throughput cap. Concretely, with `open_pull_requests_limit: 5`, eight pending
updates, and no depvisor PR currently open, a run opens five PRs — security
fixes first — and reports the remaining three as `held-back-by-limit` (green);
they open on later runs as you merge or close PRs. Open PRs from earlier runs
count against the ceiling, and depvisor always refreshes the PRs it already
opened when their targets drift (a refresh does not consume a slot).

The one-package granularity is deliberate: unrelated updates never share a PR,
so each one is reviewable — and mergeable or rejectable — on its own. The
trade-off is volume: a repository with many pending dev-dependency updates gets
many small PRs instead of one big one, throttled by the ceiling. Lower
`open_pull_requests_limit` if that is too chatty, and bundle the packages that
genuinely belong together with [`groups`](#grouping-packages-groups).

Each group runs its own agent session with a fresh reinstall in between, so a
higher `open_pull_requests_limit` costs proportionally more LLM calls and CI time. The
between-groups reinstall happens even with `install_command: skip` (which only
skips the install before the first group) and uses the package manager's
lockfile-faithful install — so multi-group runs need a committed lockfile;
without one, groups after the first are reported as `reinstall-unavailable`.

## Security prioritization

The most urgent dependency update is the one that closes a known vulnerability,
so depvisor processes those first. After grouping, it queries the
[OSV.dev](https://osv.dev) database and stable-promotes any group whose update
**resolves** a known advisory to the front of the run — ahead of routine
dependency bumps. This matters most with `open_pull_requests_limit`: security
fixes claim the run's PR slots before ordinary updates do. When a group is
prioritized, its PR body gains a **Security** column linking each resolved
advisory (`GHSA-…`) so a reviewer can see at a glance why the PR is worth merging
promptly.

Details worth knowing:

- **Ordering only**: prioritization never changes which version is installed —
  only the order groups are handled. It requires no configuration and is on by
  default.
- **Only genuine fixes are promoted**: a group is promoted only when the target
  version actually leaves the advisory's affected range. An advisory with no
  released fix yet (the current version is vulnerable and so is the latest) does
  not promote anything, because updating would not help.
- **The cooldown still wins**: prioritization runs on the version
  `minimum_release_age` would actually install, so a fix that is still inside the
  cooldown window is not treated as available yet — it is prioritized once it has
  aged enough. The supply-chain cooldown is never bypassed in the name of urgency.
- **Fail-soft**: unlike the cooldown, this is an optimization, not a defense. If
  OSV.dev is unreachable, depvisor falls back to the normal alphabetical order
  rather than failing the run, and says so in the run summary. If that note
  appears on every run, check that `api.osv.dev` is reachable from the runner
  (e.g. your egress allowlist). Private packages (absent from OSV) simply are
  not prioritized.

## New-feature suggestions (`suggest_features`)

A human reviewing a dependency update sometimes spots that the new version added
a capability worth adopting — a new API that replaces a hand-rolled helper, an
option that simplifies existing code — and notes it for a follow-up. `suggest_features`
(off by default) asks the agent to do the same: when on, after the update is done
it cross-references the "Added"/new-API items in the release notes it already read
against real symbols and files in your repository, and lists the relevant ones in
a **💡 New features that may be relevant** section in the PR body.

```yaml
suggest_features: "true"
```

This is **display-only and opt-in**. Two things make it worth turning on
deliberately rather than by default:

- **It costs extra tokens.** The suggestions come only from the release notes
  depvisor already fetched for the update (never a fetch just to look for
  features), but forming and grounding them still adds to each run's LLM bill —
  the same reason `open_pull_requests_limit` is worth watching under BYOK.
- **It widens the agent's engagement with untrusted release notes.** Release
  notes are untrusted external text, and asking the agent to mine them for
  features encourages reading them more closely (and on more updates) than a
  plain bump would. The defenses are unchanged — the agent never follows
  instructions inside release notes, and every deterministic gate still applies —
  but the exposure is larger, so it is your choice to make.

Details worth knowing:

- **depvisor never adopts a suggestion.** It reports the feature and leaves your
  code exactly as the update required; picking one up is a separate change you
  make. (There is no deterministic gate that could _prevent_ the agent from
  adopting a feature — product code is outside the scope gate, just like tests —
  so the instruction not to is a guideline the two-commit split makes reviewable,
  not a guarantee. Review the `fix:` commit as you would any code change.)
- **Heuristic and not exhaustive.** Suggestions are the agent's judgment over a
  bounded slice of the release notes; an empty (or absent) section is not a
  guarantee that no relevant feature exists. The section is capped, and when more
  are found the extra ones are dropped with an explicit note.
- **Minor/major only.** Patch releases are backward-compatible fixes with no new
  capability, so patch-only groups get no suggestion prompt at all.
- **A typo fails loudly.** Only `true`/`false` (empty means `false`) are accepted;
  anything else stops the run with `bad-suggest-features`.

## PR narrative language (`language`)

The most human-facing thing depvisor produces is the PR body's reviewer digest
(and, when the fixer ran, its account of the fixes). For a team whose reviewers
do not read English comfortably, `language` asks the agent to write that
narrative in your language instead — a restricted BCP-47-style tag such as
`ja`, `pt-BR`, or `zh-Hant`:

```yaml
language: ja
```

Only the LLM-written free text is localized: the digest's summary and notes,
and the fixer's summary, fixes, residual risks, and defer reasons — in the PR
body and wherever those summaries surface (the step summary, annotations).
Everything deterministic stays English on purpose:

- **Statuses and action outputs** (`no-verify-scripts`, `pr-prepared`, …) are a
  fixed machine vocabulary that consumer workflows branch on.
- **Commit messages** (`deps: bump …` / `fix: adapt code to …`) are part of the
  structural guarantee about who authored what; their wording is fixed.
- **Branch names and the PR body's versions marker** are PR identity — touching
  them would break idempotency.
- **PR titles and the PR body's section headings** ("What changed", table
  headers) are deterministic strings and stay English for now; the narrative
  under them carries the actual content.

Details worth knowing:

- **Empty means English** and adds nothing to the agent prompts — unset behavior
  is identical to before the knob existed.
- **A tag, not free text**: the value must match a short BCP-47-style grammar.
  Language names (`日本語`, `Brazilian Portuguese`) or any freer instruction are
  rejected with `bad-language` — the knob sets a language, it is not a prompt.
- **Code stays code**: the agent is instructed to keep identifiers, file paths,
  package names, version numbers, and commands untranslated.
