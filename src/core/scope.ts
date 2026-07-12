import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CatalogEdit } from "./bump.ts";
import { changedPaths, diffNumstat, fileAtRef, refExists } from "./git.ts";
import { asPlainMap, DEPENDENCY_FIELDS } from "./manifest.ts";
import { ALL_PM_LOCKFILES, UNSUPPORTED_PM_LOCKFILES } from "./pm.ts";

/**
 * Two scope gates bound the update, both allow-list/deny gates over a git diff:
 *
 * - `checkBumpScope` runs on the working-tree diff against the IMMUTABLE
 *   pre-bump sha (never a movable ref name — the lifecycle scripts it defends
 *   against can move refs, which would let them pick the "before" content)
 *   BEFORE the mechanical bump is committed, and allows only the changes a
 *   genuine dependency bump makes to the files that enter that commit — member version
 *   moves in dependency sections, matching pnpm-workspace.yaml catalog moves,
 *   and (uninspected) lockfiles. It exists to catch a poisoned install lifecycle
 *   script that rewrites `scripts`/`overrides`/`trustedDependencies`/etc. during
 *   the bump and would otherwise ride along in the "mechanical" bump commit,
 *   invisible to the fixer gate (which diffs FROM the bump commit).
 * - `checkFixScope` runs on everything the fixer changed relative to the bump
 *   commit, and denies ANY dependency state (the deterministic bump already
 *   owns it); the fixer may touch only source and tests.
 *
 * Both are enforced deterministically because a poisoned changelog can override
 * the agent's instructions.
 */

/**
 * Execution-surface paths a source fix must never touch, anywhere in the tree:
 * CI config, git hooks, and package-manager config. Each grants code execution
 * on some machine — a developer's, a CI runner's, or the next `install`.
 */
const DENY: RegExp[] = [
  /^\.github\//, // workflows, actions config
  /^\.husky\//, // git hooks run on developer machines
  /^\.circleci\//,
  /^\.gitlab-ci\.yml$/,
  /(^|\/)\.npmrc$/, // registry redirection → arbitrary code on next install
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)\.pnpmfile\.cjs$/, // pnpm install hooks → arbitrary code on next install
  /^pnpm-workspace\.yaml$/, // pnpm settings + catalogs — owned by the bump, not the fixer
  /^\.yarn\//, // yarn plugins/releases are executable JS
  /(^|\/)bunfig\.toml$/,
];

function isPackageJson(p: string): boolean {
  return p === "package.json" || p.endsWith("/package.json");
}

/** The root pnpm-workspace.yaml path the bump-scope catalog checks apply to. */
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * Every package-manager lockfile depvisor knows (pm.ts's `ALL_PM_LOCKFILES` —
 * derived, so a new PM's lockfiles extend this gate automatically — plus the
 * `UNSUPPORTED_PM_LOCKFILES` other tools honor even though depvisor never runs
 * them) plus pnpm's workspace/catalog file. The fixer gate denies them all
 * regardless of the detected PM — the deterministic bump owns dependency state,
 * so a lockfile the fixer touched (or created) can only be scope creep.
 * pnpm-workspace.yaml is also in DENY (root-anchored); listing it here by
 * basename additionally catches a nested one.
 */
const FIXER_DENIED_FILES = new Set([
  ...ALL_PM_LOCKFILES,
  ...UNSUPPORTED_PM_LOCKFILES,
  PNPM_WORKSPACE_FILE,
]);

/**
 * The scope gate for the fixer's changes: everything the fixer altered relative
 * to `sinceRef` — the deterministic bump commit, already HEAD when the fixer
 * starts — must be source or tests. Any DENY-list path, any package.json (by
 * basename), any PM lockfile, and pnpm-workspace.yaml is a violation
 * (fail-closed), because the bump already applied every legitimate dependency-
 * state change. Tests stay the one surface a scope gate cannot deny (adapting a
 * test to a changed API is legitimate; test-changes.ts handles them by
 * visibility instead).
 *
 * The path set is the working-tree diff against `sinceRef`: `changedPaths`
 * (working tree vs HEAD, with --untracked-files=all so a new dir's files are
 * listed individually — see git.ts) UNION any change committed between `sinceRef`
 * and HEAD. Normally sinceRef IS HEAD (the fixer edits the working tree and the
 * workflow commits afterward), so the union adds nothing; folding it in keeps the
 * gate correct if HEAD ever advances past the bump commit.
 */
export function checkFixScope(
  repo: string,
  sinceRef: string,
): { ok: boolean; violations: string[] } {
  const paths = new Set(changedPaths(repo));
  if (sinceRef !== "HEAD" && refExists(repo, sinceRef) && refExists(repo, "HEAD")) {
    for (const entry of diffNumstat(repo, sinceRef, "HEAD")) paths.add(entry.path);
  }
  const violations: string[] = [];
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (DENY.some((re) => re.test(p))) violations.push(p);
    else if (isPackageJson(p)) violations.push(p);
    else if (FIXER_DENIED_FILES.has(base)) violations.push(p);
  }
  return { ok: violations.length === 0, violations };
}

/** Key-order-insensitive stringification, so equal objects compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
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

/**
 * Whether a NEW manifest/catalog value is exactly the vetted bump target: the
 * bare `target`, `^target`, or `~target` — the only shapes the three PMs'
 * update commands and bump.ts's catalog edit ever write. A whole-string
 * grammar, NOT a substring check: `npm:evil@1.3.0` contains the target but
 * redirects the dependency to a different package, and the same goes for
 * `git:`/`file:`/`link:`/URL specifiers — all must fail. An exotic legitimate
 * shape a PM might some day write fails closed here and surfaces loudly as a
 * scope violation rather than widening the grammar silently.
 */
function isLegalBumpValue(value: unknown, target: string): boolean {
  return value === target || value === `^${target}` || value === `~${target}`;
}

/** `isLegalBumpValue` keyed on a member map (name → vetted `latest`). */
function legalMemberBump(
  value: unknown,
  name: string,
  allowed: ReadonlyMap<string, string>,
): boolean {
  const latest = allowed.get(name);
  return latest !== undefined && isLegalBumpValue(value, latest);
}

/**
 * The shared structural rule for one guarded string→value map (a package.json
 * dependency section, or one pnpm-workspace.yaml catalog): no key may be added
 * or removed, and a changed value must pass `legalChange`. Violations are
 * labeled `<prefix>.<key>`.
 */
function mapEntryViolations(
  prefix: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  legalChange: (key: string, oldValue: unknown, newValue: unknown) => boolean,
): string[] {
  const violations: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (hasOwn(before, key) !== hasOwn(after, key)) {
      violations.push(`${prefix}.${key}`); // key added or removed
      continue;
    }
    if (canonical(before[key]) === canonical(after[key])) continue; // unchanged
    if (!legalChange(key, before[key], after[key])) violations.push(`${prefix}.${key}`);
  }
  return violations;
}

/**
 * Violations in one package.json that WOULD enter the mechanical bump commit,
 * diffed base→worktree. Allow-list, all JSON-structural:
 *   - every key outside the dependency sections must be deep-equal;
 *   - inside them no key may be added or removed, and a changed value is legal
 *     only for a member whose OLD value was not a `catalog:` reference (a changed
 *     `catalog:` specifier is a de-catalog) and whose NEW value carries `latest`.
 * A package.json new/deleted/unparseable on either side is a violation
 * (fail-closed) — an install script cannot be allowed to introduce or corrupt one.
 */
function packageJsonBumpViolations(
  path: string,
  before: string | null,
  after: string | null,
  allowed: ReadonlyMap<string, string>,
): string[] {
  if (before === null) return [`${path} (new)`];
  if (after === null) return [`${path} (deleted)`];
  const beforePkg = parseJsonMap(before);
  const afterPkg = parseJsonMap(after);
  if (!beforePkg || !afterPkg) return [`${path} (unparseable)`];

  const violations: string[] = [];
  const depFields = new Set<string>(DEPENDENCY_FIELDS);
  for (const key of new Set([...Object.keys(beforePkg), ...Object.keys(afterPkg)])) {
    if (depFields.has(key)) continue;
    if (canonical(beforePkg[key]) !== canonical(afterPkg[key])) violations.push(`${path}#${key}`);
  }
  for (const section of DEPENDENCY_FIELDS) {
    if (canonical(beforePkg[section]) === canonical(afterPkg[section])) continue;
    const beforeMap = asPlainMap(beforePkg[section]);
    const afterMap = asPlainMap(afterPkg[section]);
    // A present-but-non-map section is illegible → the whole section is denied.
    if (
      (beforePkg[section] !== undefined && !beforeMap) ||
      (afterPkg[section] !== undefined && !afterMap)
    ) {
      violations.push(`${path}#${section}`);
      continue;
    }
    violations.push(
      ...mapEntryViolations(`${path}#${section}`, beforeMap ?? {}, afterMap ?? {}, (dep, o, n) => {
        // A changed `catalog:` specifier is a de-catalog, never a legal bump.
        const oldIsCatalog = typeof o === "string" && o.startsWith("catalog:");
        return !oldIsCatalog && legalMemberBump(n, dep, allowed);
      }),
    );
  }
  return violations;
}

/**
 * Violations in one catalog map (`catalog`, or one named `catalogs.<group>`),
 * either side possibly absent. No entry may be added/removed, and a changed
 * value is legal only when THIS map is a target of one of the plan's own
 * catalog edits for that entry (`allowedHere`, entry → target) and the new
 * value is the vetted target under the strict grammar. Keying the allowance on
 * the plan's edits — not on member names — means a same-named entry in a
 * catalog the plan did not touch may not change at all: only the executor's
 * own writes are legal, so a lifecycle script cannot smuggle a redirect into
 * an unreferenced catalog. A present-but-non-map side is illegible → the whole
 * map is denied.
 */
function catalogMapBumpViolations(
  label: string,
  before: unknown,
  after: unknown,
  allowedHere: ReadonlyMap<string, string>,
): string[] {
  const beforeMap = before === undefined ? {} : asPlainMap(before);
  const afterMap = after === undefined ? {} : asPlainMap(after);
  if (!beforeMap || !afterMap) return [`${PNPM_WORKSPACE_FILE}#${label} (not a map)`];
  return mapEntryViolations(`${PNPM_WORKSPACE_FILE}#${label}`, beforeMap, afterMap, (key, _o, n) =>
    legalMemberBump(n, key, allowedHere),
  );
}

/**
 * The plan's catalog-edit targets that apply to one catalog map. The default
 * catalog (`catalog: null` on the edit) may legitimately land in either the
 * top-level `catalog` map or `catalogs.default` — pnpm treats `catalog:` as
 * sugar for `catalog:default`, and bump.ts's executor resolves in that order —
 * so a default edit is allowed in both labels; a named edit only in its own.
 */
function catalogEditsFor(
  label: string,
  edits: readonly CatalogEdit[],
): ReadonlyMap<string, string> {
  const allowed = new Map<string, string>();
  for (const e of edits) {
    const matches =
      e.catalog === null
        ? label === "catalog" || label === "catalogs.default"
        : label === `catalogs.${e.catalog}`;
    if (matches) allowed.set(e.name, e.target);
  }
  return allowed;
}

/**
 * Violations in pnpm-workspace.yaml that WOULD enter the bump commit. Legal
 * differences are ONLY the plan's own catalog edits (`catalogEditsFor`), each
 * moved to exactly the vetted target; everything else — any other top-level key
 * (`packages`, `overrides`, `onlyBuiltDependencies`, …), added/removed catalog
 * entries or named catalogs, changes in catalogs the plan did not target, an
 * unparseable/non-map side, creation or deletion — is a violation (fail-closed).
 */
function pnpmWorkspaceBumpViolations(
  before: string | null,
  after: string | null,
  catalogEdits: readonly CatalogEdit[],
): string[] {
  if (before === null) return [`${PNPM_WORKSPACE_FILE} (created)`];
  if (after === null) return [`${PNPM_WORKSPACE_FILE} (deleted)`];
  let beforeRoot: Record<string, unknown> | null;
  let afterRoot: Record<string, unknown> | null;
  try {
    beforeRoot = asPlainMap(parseYaml(before));
    afterRoot = asPlainMap(parseYaml(after));
  } catch {
    return [`${PNPM_WORKSPACE_FILE} (unparseable)`];
  }
  if (!beforeRoot || !afterRoot) return [`${PNPM_WORKSPACE_FILE} (unparseable)`];

  const violations: string[] = [];
  for (const key of new Set([...Object.keys(beforeRoot), ...Object.keys(afterRoot)])) {
    if (key === "catalog" || key === "catalogs") continue;
    if (canonical(beforeRoot[key]) !== canonical(afterRoot[key])) {
      violations.push(`${PNPM_WORKSPACE_FILE}#${key}`);
    }
  }
  violations.push(
    ...catalogMapBumpViolations(
      "catalog",
      beforeRoot.catalog,
      afterRoot.catalog,
      catalogEditsFor("catalog", catalogEdits),
    ),
  );
  const beforeCatalogs = beforeRoot.catalogs === undefined ? {} : asPlainMap(beforeRoot.catalogs);
  const afterCatalogs = afterRoot.catalogs === undefined ? {} : asPlainMap(afterRoot.catalogs);
  if (!beforeCatalogs || !afterCatalogs) {
    violations.push(`${PNPM_WORKSPACE_FILE}#catalogs (not a map)`);
  } else {
    for (const name of new Set([...Object.keys(beforeCatalogs), ...Object.keys(afterCatalogs)])) {
      if (hasOwn(beforeCatalogs, name) !== hasOwn(afterCatalogs, name)) {
        violations.push(`${PNPM_WORKSPACE_FILE}#catalogs.${name}`); // named catalog added/removed
        continue;
      }
      const label = `catalogs.${name}`;
      violations.push(
        ...catalogMapBumpViolations(
          label,
          beforeCatalogs[name],
          afterCatalogs[name],
          catalogEditsFor(label, catalogEdits),
        ),
      );
    }
  }
  return violations;
}

/**
 * The bump-path scope gate: everything the deterministic bump changed that WOULD
 * enter the mechanical bump commit (`git.ts:manifestBumpPaths`) — every changed
 * `package.json` (by basename, including nested workspace manifests) and the root
 * `pnpm-workspace.yaml` — must match a genuine version bump of the group's own
 * `members` (name → `latest`) under the strict grammar, with pnpm-workspace.yaml
 * changes additionally keyed to the plan's own `catalogEdits`. PM lockfiles are
 * allowed without content inspection (they are generated, not executable
 * config); any other path never enters the bump commit and is left to the later
 * `checkFixScope`. Fail-closed: it exists to catch a poisoned install lifecycle
 * script that rewrote a manifest during the bump, which would otherwise be
 * committed as the "mechanical" bump and slip past every later gate.
 *
 * `preBumpSha` must be the IMMUTABLE sha snapshotted before the bump ran, never
 * a ref name: the same lifecycle scripts this gate defends against can move a
 * branch ref, which would let them choose the "before" content this gate
 * compares. The caller has already rejected any HEAD movement during the bump
 * (`unexpected-commits`), so the `changedPaths` working-tree enumeration and
 * the `preBumpSha` content reads describe the same diff.
 */
export function checkBumpScope(
  repo: string,
  preBumpSha: string,
  members: readonly { name: string; latest: string }[],
  catalogEdits: readonly CatalogEdit[],
): { ok: boolean; violations: string[] } {
  const allowed = new Map(members.map((m) => [m.name, m.latest] as const));
  const workingTreeFile = (p: string): string | null => {
    try {
      return readFileSync(join(repo, p), "utf8");
    } catch {
      return null; // deleted in the working tree
    }
  };
  const violations: string[] = [];
  for (const p of changedPaths(repo)) {
    if (isPackageJson(p)) {
      violations.push(
        ...packageJsonBumpViolations(
          p,
          fileAtRef(repo, preBumpSha, p),
          workingTreeFile(p),
          allowed,
        ),
      );
    } else if (p === PNPM_WORKSPACE_FILE) {
      violations.push(
        ...pnpmWorkspaceBumpViolations(
          fileAtRef(repo, preBumpSha, p),
          workingTreeFile(p),
          catalogEdits,
        ),
      );
    }
    // Lockfiles are allowed without inspection; any other path is not committed
    // to the bump commit, so it is not this gate's concern.
  }
  return { ok: violations.length === 0, violations };
}
