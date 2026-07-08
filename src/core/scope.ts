import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { changedPaths, fileAtRef } from "./git.ts";

/**
 * Diff-scope gate. The agent is instructed not to touch unrelated files, but a
 * poisoned changelog can override instructions; this deny-list is enforced
 * deterministically before anything is committed.
 */
const DENY: RegExp[] = [
  /^\.github\//, // workflows, actions config
  /^\.husky\//, // git hooks run on developer machines
  /^\.circleci\//,
  /^\.gitlab-ci\.yml$/,
  /(^|\/)\.npmrc$/, // registry redirection → arbitrary code on next install
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)\.pnpmfile\.cjs$/, // pnpm install hooks → arbitrary code on next install
  // pnpm settings, incl. which deps may run build scripts. On pnpm targets a
  // structured carve-out applies instead of this flat deny: catalog version
  // bumps for the group's own packages are legal (the instructed hand edit —
  // see pm.ts) — see pnpmWorkspaceCatalogViolations/checkDiffScope.
  /^pnpm-workspace\.yaml$/,
  /^\.yarn\//, // yarn plugins/releases are executable JS
  /(^|\/)bunfig\.toml$/,
];

/** The root pnpm-workspace.yaml path the catalog carve-out applies to. */
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

export function scopeViolations(paths: string[]): string[] {
  return paths.filter((p) => DENY.some((re) => re.test(p)));
}

function isPackageJson(p: string): boolean {
  return p === "package.json" || p.endsWith("/package.json");
}

/**
 * package.json fields a dependency bump should not edit. Each controls code
 * execution or dependency sources: `scripts`, `packageManager`, `pnpm`,
 * `overrides`/`resolutions`, bun's lifecycle-script allowlist
 * (`trustedDependencies`) and patch list (`patchedDependencies`), and the
 * workspace/catalog fields (`workspaces`, `catalog`, `catalogs`) — bun keeps
 * catalogs in package.json, where pnpm's live in the denied
 * pnpm-workspace.yaml. Updates that need these changes must be deferred to a
 * human.
 */
const GUARDED_FIELDS = [
  "scripts",
  "packageManager",
  "pnpm",
  "overrides",
  "resolutions",
  "trustedDependencies",
  "patchedDependencies",
  "workspaces",
  "catalog",
  "catalogs",
] as const;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** A named field of a package.json source; undefined when absent/unparseable. */
function fieldOf(source: string | null, field: string): unknown {
  if (source === null) return undefined;
  try {
    const pkg = JSON.parse(source) as Record<string, unknown>;
    return pkg && typeof pkg === "object" ? pkg[field] : undefined;
  } catch {
    return undefined;
  }
}

/** Key-order-insensitive stringification, so equal objects compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** A parsed YAML/JSON value that is a plain string→value map. */
function asPlainMap(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonMap(source: string | null): Record<string, unknown> | null {
  if (source === null) return null;
  try {
    return asPlainMap(JSON.parse(source));
  } catch {
    return null;
  }
}

function hasOwn(map: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(map, key);
}

function isCatalogProtocol(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("catalog:");
}

/**
 * Whether `value` is a sanctioned catalog specifier for the vetted target
 * version: exactly `<latest>`, `^<latest>`, or `~<latest>` (what `pnpm update`
 * itself writes, save-prefix depending). String comparison on purpose — no
 * range parsing — so `npm:`/`git`/`file:`/`link:` specifiers (dependency-source
 * redirection) and wider ranges (reaching past the vetted version) are
 * structurally impossible.
 */
function isSanctionedCatalogValue(value: unknown, latest: string): boolean {
  return value === latest || value === `^${latest}` || value === `~${latest}`;
}

/**
 * Violations in one catalog map (`catalog` or one entry of `catalogs`), where
 * either side may be absent. The key set must be identical — a version bump
 * never adds or removes catalog entries — and each changed value must be a
 * sanctioned specifier for a package this group is updating (`allowed` maps
 * package name → vetted target version).
 */
function catalogMapViolations(
  label: string,
  before: unknown,
  after: unknown,
  allowed: ReadonlyMap<string, string>,
): string[] {
  const violations: string[] = [];
  // Absent = no entries; a present-but-non-map side is illegible → fail closed.
  const beforeMap = before === undefined ? {} : asPlainMap(before);
  const afterMap = after === undefined ? {} : asPlainMap(after);
  if (!beforeMap || !afterMap) return [`${PNPM_WORKSPACE_FILE} (${label} is not a map)`];
  for (const key of new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
    if (!hasOwn(afterMap, key)) {
      violations.push(`${PNPM_WORKSPACE_FILE} (${label}: "${key}" removed)`);
    } else if (!hasOwn(beforeMap, key)) {
      violations.push(`${PNPM_WORKSPACE_FILE} (${label}: "${key}" added)`);
    } else if (canonical(beforeMap[key]) !== canonical(afterMap[key])) {
      const latest = allowed.get(key);
      if (latest === undefined || !isSanctionedCatalogValue(afterMap[key], latest)) {
        violations.push(`${PNPM_WORKSPACE_FILE} (${label}: "${key}")`);
      }
    }
  }
  return violations;
}

/**
 * The structured carve-out that replaces pnpm-workspace.yaml's flat deny on
 * pnpm targets. pnpm keeps catalog versions in this file, so a catalog-pinned
 * dependency is only updatable through it (via the hand edit the task prompt
 * instructs — see pm.ts) — but the same file also holds execution-relevant
 * settings (`onlyBuiltDependencies`, `overrides`, `packages`, …), so instead of
 * allowing the file it allows exactly one diff shape: existing `catalog` /
 * `catalogs.<name>` entries of the group's own packages moving to the vetted
 * target version. Everything else — any non-catalog difference, added/removed
 * entries, non-member packages, non-sanctioned specifiers, an unparseable or
 * non-map side, a created/deleted file — is a violation (fail-closed).
 */
export function pnpmWorkspaceCatalogViolations(
  before: string | null,
  after: string | null,
  allowed: ReadonlyMap<string, string>,
): string[] {
  if (before === null) return [`${PNPM_WORKSPACE_FILE} (created)`];
  if (after === null) return [`${PNPM_WORKSPACE_FILE} (deleted)`];
  let beforeRoot: Record<string, unknown> | null;
  let afterRoot: Record<string, unknown> | null;
  try {
    // Strict single-document parse (default schema: no custom tags, duplicate
    // keys and multi-document sources throw, alias expansion is capped) so an
    // attacker cannot smuggle a change behind a parse quirk. Any throw or a
    // non-map root is illegible → violation.
    beforeRoot = asPlainMap(parseYaml(before));
    afterRoot = asPlainMap(parseYaml(after));
  } catch {
    return [`${PNPM_WORKSPACE_FILE} (unparseable)`];
  }
  if (!beforeRoot || !afterRoot) return [`${PNPM_WORKSPACE_FILE} (unparseable)`];

  const violations: string[] = [];
  // Everything except catalog/catalogs must be canonically identical.
  for (const key of new Set([...Object.keys(beforeRoot), ...Object.keys(afterRoot)])) {
    if (key === "catalog" || key === "catalogs") continue;
    if (canonical(beforeRoot[key]) !== canonical(afterRoot[key])) {
      violations.push(`${PNPM_WORKSPACE_FILE} (${key})`);
    }
  }

  violations.push(
    ...catalogMapViolations("catalog", beforeRoot.catalog, afterRoot.catalog, allowed),
  );

  // catalogs: named catalog maps, one level deeper — same rules per name, and
  // the set of named catalogs itself must not change.
  const beforeCatalogs = beforeRoot.catalogs === undefined ? {} : asPlainMap(beforeRoot.catalogs);
  const afterCatalogs = afterRoot.catalogs === undefined ? {} : asPlainMap(afterRoot.catalogs);
  if (!beforeCatalogs || !afterCatalogs) {
    violations.push(`${PNPM_WORKSPACE_FILE} (catalogs is not a map)`);
  } else {
    for (const name of new Set([...Object.keys(beforeCatalogs), ...Object.keys(afterCatalogs)])) {
      if (!hasOwn(afterCatalogs, name)) {
        violations.push(`${PNPM_WORKSPACE_FILE} (catalogs: "${name}" removed)`);
      } else if (!hasOwn(beforeCatalogs, name)) {
        violations.push(`${PNPM_WORKSPACE_FILE} (catalogs: "${name}" added)`);
      } else {
        violations.push(
          ...catalogMapViolations(
            `catalogs.${name}`,
            beforeCatalogs[name],
            afterCatalogs[name],
            allowed,
          ),
        );
      }
    }
  }
  return violations;
}

/**
 * The guarded fields that differ between two package.json contents (either
 * side may be null = file absent). Any difference is out of scope — see
 * `checkDiffScope`. Unequal on any doubt (added/removed key, changed value,
 * one side unparseable while the other has the field).
 */
export function packageJsonGuardedFieldChanges(
  before: string | null,
  after: string | null,
): string[] {
  return GUARDED_FIELDS.filter(
    (field) => canonical(fieldOf(before, field)) !== canonical(fieldOf(after, field)),
  );
}

/**
 * Dependency-section `catalog:` protocol entries are package-manager source
 * selectors, not ordinary version strings. A version bump may move the backing
 * catalog entry (for pnpm, in pnpm-workspace.yaml), but it must not add, remove,
 * or rewrite the package.json protocol specifier itself.
 */
export function packageJsonCatalogProtocolChanges(
  before: string | null,
  after: string | null,
): string[] {
  const beforePkg = parseJsonMap(before);
  const afterPkg = parseJsonMap(after);
  const violations: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const beforeMap = asPlainMap(beforePkg?.[field]) ?? {};
    const afterMap = asPlainMap(afterPkg?.[field]) ?? {};
    for (const key of new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
      const beforeValue = hasOwn(beforeMap, key) ? beforeMap[key] : undefined;
      const afterValue = hasOwn(afterMap, key) ? afterMap[key] : undefined;
      if (
        (isCatalogProtocol(beforeValue) || isCatalogProtocol(afterValue)) &&
        canonical(beforeValue) !== canonical(afterValue)
      ) {
        violations.push(`${field}: "${key}" catalog protocol`);
      }
    }
  }
  return violations;
}

/**
 * Deny-list violations plus package.json guarded-field tampering. package.json
 * must allow version bumps, so each changed package.json is diffed against
 * `base`; any change to a guarded field is a scope violation because it can
 * affect lifecycle execution or dependency resolution in the target project.
 *
 * `catalogBumps` (package name → vetted target version) opts the root
 * pnpm-workspace.yaml into the structured catalog carve-out instead of the
 * flat deny — pass it only on pnpm targets, where a catalog-pinned update
 * legitimately rewrites that file; see pnpmWorkspaceCatalogViolations.
 */
export function checkDiffScope(
  repo: string,
  base: string,
  opts?: { catalogBumps?: ReadonlyMap<string, string> },
): { ok: boolean; violations: string[] } {
  const paths = changedPaths(repo);
  const catalogBumps = opts?.catalogBumps;
  const carvedOut = (p: string) => catalogBumps !== undefined && p === PNPM_WORKSPACE_FILE;
  const violations = scopeViolations(paths.filter((p) => !carvedOut(p)));
  const workingTreeFile = (p: string): string | null => {
    try {
      return readFileSync(join(repo, p), "utf8");
    } catch {
      return null; // deleted in the working tree
    }
  };
  for (const p of paths) {
    if (carvedOut(p) && catalogBumps !== undefined) {
      violations.push(
        ...pnpmWorkspaceCatalogViolations(
          fileAtRef(repo, base, p),
          workingTreeFile(p),
          catalogBumps,
        ),
      );
      continue;
    }
    if (!isPackageJson(p)) continue;
    const after = workingTreeFile(p);
    for (const field of packageJsonGuardedFieldChanges(fileAtRef(repo, base, p), after)) {
      violations.push(`${p} (${field})`);
    }
    for (const field of packageJsonCatalogProtocolChanges(fileAtRef(repo, base, p), after)) {
      violations.push(`${p} (${field})`);
    }
  }
  return { ok: violations.length === 0, violations };
}
