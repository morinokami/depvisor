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
   * workspace-scoped update command (`PmToolchain.updateInstruction`). For pnpm
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
