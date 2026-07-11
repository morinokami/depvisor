export type UpdateType = "patch" | "minor" | "major" | "unknown";
export type DepKind = "prod" | "dev";

export interface Candidate {
  name: string;
  current: string;
  latest: string;
  kind: DepKind;
  updateType: UpdateType;
  /**
   * Repo-relative paths of the workspaces that declare this dependency; the root
   * package.json is "" (a single-package repo is therefore `[""]`). Drives the
   * workspace-scoped update command (`PmToolchain.updatePlan`). For pnpm
   * this may omit occurrences that `pnpm outdated -r` collapsed behind a
   * name-key collision — harmless, because `pnpm -r update` updates every
   * declaring workspace regardless.
   */
  locations: string[];
  /**
   * Distinct `current` versions this dependency is declared at across the
   * declaring workspaces. `current` above is the LOWEST of these (the most
   * conservative update-type classification), but advisory matching
   * (`core/advisories.ts`) checks EVERY entry so a vulnerability affecting only a
   * higher-versioned workspace is not hidden behind the lowest. npm/bun can
   * report several; pnpm collapses cross-workspace occurrences to one. Absent →
   * treat as `[current]`.
   */
  currents?: string[];
}

/**
 * One unit of update = one prospective PR. The key is the stable branch/PR
 * identity (see grouping.ts). By default every group is a singleton — one
 * package — and the user-declared `groups` config (Dependabot's `groups`)
 * bundles several packages into one group; everything downstream (prompt,
 * gates, PR body, labels) handles the plural.
 */
export interface Group {
  key: string;
  reason: string;
  members: Candidate[];
}

/** Agent-written digest of one package's release notes. */
export interface NotableChange {
  package: string;
  note: string;
}

/**
 * Agent-suggested newly added capability from an update's release notes that may
 * relate to code already in the repository (the opt-in suggest_features feature).
 * Display-only, never adopted; `package` names one updated package, `summary`
 * describes the capability, and `codebaseRelevance` names the concrete existing
 * symbol or file it could improve. Both free-text fields are untrusted (release
 * notes + LLM judgment), so pr.ts sanitizes them like any other narrative field.
 */
export interface RelevantNewFeature {
  package: string;
  summary: string;
  codebaseRelevance: string;
}

/**
 * The agent's structured account of an update. Keeping fields separate lets the
 * PR renderer compose the body deterministically and sanitize each untrusted,
 * changelog-derived field on its own.
 */
export interface UpdateNarrative {
  summary: string;
  notableChanges: NotableChange[];
  breakingChangesAddressed: string[];
  residualRisks: string[];
}
