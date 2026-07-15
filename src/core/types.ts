export type UpdateType = "patch" | "minor" | "major" | "unknown";
export type DepKind = "prod" | "dev" | "transitive";

/**
 * One dependency the updater PR changes, extracted deterministically from the
 * base→head diff (see dep-diff.ts). `from`/`to` are resolved lockfile versions
 * when the lockfile parsed, else the manifest specifiers — either way they are
 * observations of what the UPDATER changed, never something depvisor chose.
 */
export interface DependencyChange {
  name: string;
  from: string;
  to: string;
  /** Which manifest section declares it; direct changes only. */
  kind: DepKind;
  updateType: UpdateType;
  /**
   * Repo-relative paths of the workspaces that declare this dependency at the
   * head tree; the root package.json is "" (a single-package repo is [""]).
   * Display/prompt context only — depvisor never edits dependency state.
   */
  locations: string[];
}

/** Agent-written digest of one package's release notes. */
export interface NotableChange {
  package: string;
  note: string;
}

/**
 * The agents' structured account of the update, composed into the reviewer
 * report. Keeping fields separate lets the report renderer build the comment
 * deterministically and sanitize each untrusted, changelog-derived field on
 * its own.
 */
export interface UpdateNarrative {
  summary: string;
  notableChanges: NotableChange[];
  breakingChangesAddressed: string[];
  residualRisks: string[];
}
