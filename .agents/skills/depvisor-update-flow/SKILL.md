---
name: depvisor-update-flow
description: Use when changing or reasoning about depvisor v2's one-PR aftercare flow — resolver/provider attestation, base-SHA config, ecosystem normalization, policy, isolated verification, one-shot fixer/reviewer, candidate scope, publication, and terminal statuses.
---

# depvisor v2 aftercare flow

One run handles one immutable existing updater PR head. There is no candidate
collection, deterministic bump, group loop, branch naming, or PR creation.

1. `cli/resolve.ts` maps workflow run SHA to exactly one open PR (or accepts a
   manual PR), reads `.github/depvisor.yml` from the base-tip SHA, attests the
   provider and commit chain, recognizes at most one depvisor repair tip, and
   captures base/merge-base/PR/updater head SHAs.
2. `cli/normalize.ts` recomputes the merge base locally, diffs
   `mergeBase...updaterHead`, routes dependency files through independent
   ecosystem adapters, applies cost/report/repair policy, and gates repair on a
   complete PR-level `repair-safe` classification.
3. Green trigger CI needs no repair verification. Selected review is independent
   and read-only. A red trigger enters repair only for a fresh in-repo provider
   head with trusted commands and no existing depvisor repair.
4. Baseline and head run in separate credential-free jobs. Each starts clean,
   runs base-SHA prepare/commands, seals refs/tree, and confirms failures once.
   Only green baseline + stable-red head invokes the fixer.
5. The fixer starts at immutable updater head, has repo-jailed read/write tools
   but no shell/git, and gets one attempt. `cli/candidate.ts` enforces
   source/test-only scope and serializes a bounded content-addressed patch.
6. Candidate verification applies that exact patch in another credential-free
   job, rechecks scope, runs all trusted commands once, and seals refs/worktree.
   A failed candidate is reported and never retried into acceptance.
7. The independently selected reviewer has read-only repo tools and is fail-soft.
   It separates observed evidence from inference; deterministic rendering decides
   whether a repair is called applied.
8. The publisher is the only write-token job. It re-queries PR/base/head/provider,
   validates artifact/hash/scope, applies the patch in a fresh clone, creates one
   trailer-marked commit, normal-pushes (never force), then upserts its comment and
   Check. Stale state is a neutral no-op.

Existing depvisor repair + red CI requests updater regeneration; never stack a
second repair. Dependabot uses `[dependabot skip]` and may receive
`@dependabot rebase`; Renovate uses the trusted configured rebase label or a
manual retry-checkbox handoff.

## Status vocabulary

Neutral: `no-target`, `not-updater`, `policy-skipped`,
`updater-refresh-requested`, `stale-base`, `stale-head`, `human-takeover`.

Green: `reviewed`, `repair-not-needed`, `repair-applied`.

Red: `unsupported-provider`, `untrusted-updater`, `bad-config`,
`verification-unavailable`, `repair-unsupported`, `updater-refresh-required`,
`baseline-red`, `verification-unstable`, `failure-not-reproduced`,
`repair-deferred`, `verification-failed`, `scope-violation`,
`unexpected-commits`, `publish-failed`. `in-progress` is crash-only.

Add statuses to `types.ts`, `status.ts`, `result.ts`, `docs/results.md`, and
`start.md` together.
