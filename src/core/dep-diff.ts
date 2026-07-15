import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AGENT_EMAIL,
  changedPathsInCommit,
  commitsInRange,
  diffNumstat,
  fileAtRef,
  lsTreePaths,
} from "./git.ts";
import { asPlainMap, DEPENDENCY_FIELDS } from "./manifest.ts";
import type { PmToolchain } from "./pm.ts";
import { isDependencyStatePath } from "./scope.ts";
import type { DependencyChange, DepKind, UpdateType } from "./types.ts";
import { compareTriple, parseVersionCore } from "./version-core.ts";

/**
 * Deterministic extraction of WHAT an updater PR changes, from the committed
 * base→head diff alone. This replaces v1's registry scan: depvisor no longer
 * decides which versions to move to — Dependabot/Renovate did — it only reads
 * their change so the fixer prompt, the reviewer report, and the statuses can
 * name it precisely.
 *
 * Two independent jobs live here:
 *
 * - `classifyPrCommits` — the fail-closed "is this a pure dependency-update
 *   PR?" gate: every commit in the range must either touch only
 *   dependency-state paths (`scope.ts:isDependencyStatePath` — the same
 *   vocabulary the fixer gate denies, so what the updater may write and what
 *   the fixer may not stay one definition) or carry depvisor's own committer
 *   sentinel (a repair commit from a previous run). Anything else means a
 *   human pushed work onto the branch, and depvisor must not build a repair
 *   on it.
 * - `diffDependencies` — the package-level change set. Resolved versions come
 *   from the per-PM lockfile diff when the lockfile parses (this is what
 *   catches Dependabot's lockfile-only in-range updates, whose manifests do
 *   not change); the manifest specifier diff is the fallback. Lockfile parsing
 *   is display/prompt input, so it fails soft toward the fallback — the
 *   security gates never depend on it.
 */

/** Classify an update as patch/minor/major from version(-ish) strings. */
export function classifyUpdate(from: string, to: string): UpdateType {
  const c = parseVersionCore(from);
  const l = parseVersionCore(to);
  if (!c || !l) return "unknown";
  if (l[0] > c[0]) return "major";
  if (l[0] === c[0] && l[1] > c[1]) return "minor";
  if (l[0] === c[0] && l[1] === c[1] && l[2] > c[2]) return "patch";
  return "unknown";
}

export type PrCommitClassification =
  | { ok: true; ownCommits: number; updaterCommits: number }
  | { ok: false; foreign: { sha: string; paths: string[] }[] };

/**
 * Verify that every commit in `mergeBaseSha..headSha` is either a
 * dependency-state-only commit (the updater's work) or a depvisor repair
 * commit (committer sentinel). A merge commit is judged by its first-parent
 * diff like any other. Fail-closed: an unclassifiable commit is foreign.
 */
export function classifyPrCommits(
  repo: string,
  mergeBaseSha: string,
  headSha: string,
): PrCommitClassification {
  const commits = commitsInRange(repo, mergeBaseSha, headSha);
  const foreign: { sha: string; paths: string[] }[] = [];
  let ownCommits = 0;
  let updaterCommits = 0;
  for (const commit of commits) {
    if (commit.committerEmail === AGENT_EMAIL) {
      ownCommits += 1;
      continue;
    }
    const offending = changedPathsInCommit(repo, commit.sha).filter(
      (p) => !isDependencyStatePath(p),
    );
    if (offending.length > 0) {
      foreign.push({ sha: commit.sha, paths: offending.toSorted() });
    } else {
      updaterCommits += 1;
    }
  }
  return foreign.length > 0 ? { ok: false, foreign } : { ok: true, ownCommits, updaterCommits };
}

/** One direct dependency declaration at a ref, merged across workspaces. */
interface Declaration {
  spec: string;
  kind: DepKind;
  locations: string[];
}

/** The `catalog`/`catalogs` maps of pnpm-workspace.yaml at a ref. */
function pnpmCatalogs(repo: string, ref: string): Map<string, string> {
  const source = fileAtRef(repo, ref, "pnpm-workspace.yaml");
  if (source === null) return new Map();
  let root: Record<string, unknown> | null;
  try {
    root = asPlainMap(parseYaml(source));
  } catch {
    return new Map();
  }
  if (!root) return new Map();
  const out = new Map<string, string>();
  const add = (label: string, map: unknown): void => {
    const entries = asPlainMap(map);
    if (!entries) return;
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value === "string") out.set(`${label}\0${name}`, value);
    }
  };
  add("default", root.catalog);
  const catalogs = asPlainMap(root.catalogs);
  if (catalogs) {
    for (const [label, map] of Object.entries(catalogs)) add(label, map);
  }
  return out;
}

/** Resolve a `catalog:`/`catalog:<name>` specifier through the ref's catalogs. */
function resolveCatalogSpec(
  spec: string,
  name: string,
  catalogs: ReadonlyMap<string, string>,
): string {
  if (!spec.startsWith("catalog:")) return spec;
  const label = spec.slice("catalog:".length) || "default";
  return catalogs.get(`${label}\0${name}`) ?? spec;
}

/**
 * Every direct dependency declared at `ref`, across the root and every
 * workspace manifest in the tree (found by basename, no workspace-config
 * parsing needed). `prod` wins over `dev` when a name appears in both kinds.
 * pnpm `catalog:` specifiers resolve through pnpm-workspace.yaml at the same
 * ref, so a catalog-pinned bump surfaces as a spec change like any other.
 */
export function declaredDependencies(
  repo: string,
  ref: string,
  pm: PmToolchain,
): Map<string, Declaration> {
  const catalogs =
    pm.extraManifestFiles.length > 0 ? pnpmCatalogs(repo, ref) : new Map<string, string>();
  const out = new Map<string, Declaration>();
  const manifests = lsTreePaths(repo, ref).filter(
    (p) => (p === "package.json" || p.endsWith("/package.json")) && !p.includes("node_modules/"),
  );
  for (const path of manifests) {
    const source = fileAtRef(repo, ref, path);
    if (source === null) continue;
    let manifest: Record<string, unknown> | null;
    try {
      manifest = asPlainMap(JSON.parse(source));
    } catch {
      continue;
    }
    if (!manifest) continue;
    const location = path === "package.json" ? "" : dirname(path);
    for (const section of DEPENDENCY_FIELDS) {
      const entries = asPlainMap(manifest[section]);
      if (!entries) continue;
      const kind: DepKind = section === "devDependencies" ? "dev" : "prod";
      for (const [name, rawSpec] of Object.entries(entries)) {
        if (typeof rawSpec !== "string") continue;
        const spec = resolveCatalogSpec(rawSpec, name, catalogs);
        const existing = out.get(name);
        if (existing) {
          if (!existing.locations.includes(location)) existing.locations.push(location);
          if (kind === "prod") existing.kind = "prod";
          // Keep the first spec seen; cross-workspace spec skew is rare and
          // this map only feeds display/prompt strings.
        } else {
          out.set(name, { spec, kind, locations: [location] });
        }
      }
    }
  }
  for (const decl of out.values()) decl.locations.sort();
  return out;
}

function versionsFromNpmV1Deps(deps: unknown, out: Map<string, Set<string>>): void {
  const entries = asPlainMap(deps);
  if (!entries) return;
  for (const [name, raw] of Object.entries(entries)) {
    const entry = asPlainMap(raw);
    if (!entry) continue;
    if (typeof entry.version === "string") {
      const set = out.get(name) ?? new Set<string>();
      set.add(entry.version);
      out.set(name, set);
    }
    if (entry.dependencies) versionsFromNpmV1Deps(entry.dependencies, out);
  }
}

function npmLockVersions(source: string): Map<string, Set<string>> | null {
  let root: Record<string, unknown> | null;
  try {
    root = asPlainMap(JSON.parse(source));
  } catch {
    return null;
  }
  if (!root) return null;
  const out = new Map<string, Set<string>>();
  const packages = asPlainMap(root.packages);
  if (packages) {
    for (const [key, raw] of Object.entries(packages)) {
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue; // "" is the root project, workspace keys carry no resolution
      const name = key.slice(idx + "node_modules/".length);
      const entry = asPlainMap(raw);
      if (!entry || typeof entry.version !== "string") continue;
      const set = out.get(name) ?? new Set<string>();
      set.add(entry.version);
      out.set(name, set);
    }
    return out;
  }
  // lockfileVersion 1: nested `dependencies` maps.
  if (root.dependencies) {
    versionsFromNpmV1Deps(root.dependencies, out);
    return out;
  }
  return null;
}

function pnpmLockVersions(source: string): Map<string, Set<string>> | null {
  let root: Record<string, unknown> | null;
  try {
    root = asPlainMap(parseYaml(source));
  } catch {
    return null;
  }
  if (!root) return null;
  const packages = asPlainMap(root.packages) ?? asPlainMap(root.snapshots);
  if (!packages) return null;
  const out = new Map<string, Set<string>>();
  for (const key of Object.keys(packages)) {
    // v9: "name@version(peers)"; v6–8: "/name@version(peers)"; peers in "(…)".
    const bare = key.replace(/^\//, "").replace(/\(.*$/, "");
    const at = bare.lastIndexOf("@");
    if (at <= 0) continue;
    const name = bare.slice(0, at);
    const version = bare.slice(at + 1);
    if (!name || !version) continue;
    const set = out.get(name) ?? new Set<string>();
    set.add(version);
    out.set(name, set);
  }
  return out;
}

function bunLockVersions(source: string): Map<string, Set<string>> | null {
  // bun.lock is JSONC with trailing commas; strip them before parsing. A
  // version/name string never contains `,}`/`,]`, so the rewrite is safe for
  // the fields read here — and a surprise still just fails toward null.
  let root: Record<string, unknown> | null;
  try {
    root = asPlainMap(JSON.parse(source.replace(/,\s*([}\]])/g, "$1")));
  } catch {
    return null;
  }
  if (!root) return null;
  const packages = asPlainMap(root.packages);
  if (!packages) return null;
  const out = new Map<string, Set<string>>();
  for (const raw of Object.values(packages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
    const at = raw[0].lastIndexOf("@");
    if (at <= 0) continue;
    const name = raw[0].slice(0, at);
    const version = raw[0].slice(at + 1);
    if (!name || !version) continue;
    const set = out.get(name) ?? new Set<string>();
    set.add(version);
    out.set(name, set);
  }
  return out;
}

/**
 * Resolved package versions at `ref` from the PM's committed lockfile, or null
 * when no lockfile exists there or it does not parse (binary bun.lockb
 * included). Names map to version SETS: a monorepo can hold several.
 */
export function lockfileVersions(
  repo: string,
  ref: string,
  pm: PmToolchain,
): Map<string, Set<string>> | null {
  for (const lockfile of pm.lockfiles) {
    const source = fileAtRef(repo, ref, lockfile);
    if (source === null) continue;
    if (pm.name === "npm") return npmLockVersions(source);
    if (pm.name === "pnpm") return pnpmLockVersions(source);
    if (lockfile === "bun.lock") return bunLockVersions(source);
    return null; // bun.lockb is binary — fall back to the manifest diff
  }
  return null;
}

function sortVersions(versions: ReadonlySet<string>): string[] {
  return [...versions].toSorted((a, b) => {
    const pa = parseVersionCore(a);
    const pb = parseVersionCore(b);
    if (pa && pb) return compareTriple(pa, pb);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function sameVersions(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): boolean {
  if (!a || !b || a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface DepDiff {
  /** Direct dependency changes (declared in a manifest at head or base). */
  direct: DependencyChange[];
  /** Changed lockfile packages that no manifest declares (transitive). */
  transitives: string[];
  /** Whether `from`/`to` are lockfile-resolved versions (else manifest specs). */
  lockfileResolved: boolean;
  /** Dependency-state paths the PR changed, sorted. */
  changedFiles: string[];
}

/**
 * The dependency-level change set of `baseSha..headSha`. Lockfile-resolved
 * when both sides' lockfiles parse; manifest-spec fallback otherwise. Either
 * way `direct` covers every declared dependency whose resolution or specifier
 * changed, so a lockfile-only Dependabot update (manifest untouched) and a
 * spec bump both surface. An empty `direct` + empty `transitives` means the
 * PR changes no dependency depvisor can name.
 */
export function diffDependencies(
  repo: string,
  baseSha: string,
  headSha: string,
  pm: PmToolchain,
): DepDiff {
  const changedFiles = diffNumstat(repo, baseSha, headSha)
    .map((e) => e.path)
    .filter(isDependencyStatePath)
    .toSorted();

  const declBase = declaredDependencies(repo, baseSha, pm);
  const declHead = declaredDependencies(repo, headSha, pm);
  const lockBase = lockfileVersions(repo, baseSha, pm);
  const lockHead = lockfileVersions(repo, headSha, pm);
  const lockfileResolved = lockBase !== null && lockHead !== null;

  const direct = new Map<string, DependencyChange>();
  const transitives: string[] = [];

  if (lockfileResolved) {
    for (const name of new Set([...lockBase.keys(), ...lockHead.keys()])) {
      const before = lockBase.get(name);
      const after = lockHead.get(name);
      if (sameVersions(before, after)) continue;
      const decl = declHead.get(name) ?? declBase.get(name);
      if (!decl) {
        transitives.push(name);
        continue;
      }
      const from = before ? (sortVersions(before)[0] ?? "") : "";
      const to = after ? (sortVersions(after).at(-1) ?? "") : "";
      direct.set(name, {
        name,
        from: from || "(absent)",
        to: to || "(removed)",
        kind: decl.kind,
        updateType: from && to ? classifyUpdate(from, to) : "unknown",
        locations: decl.locations,
      });
    }
  }

  // Manifest specifier changes: authoritative in fallback mode, and a safety
  // net in resolved mode for a spec change the lockfile diff missed.
  for (const name of new Set([...declBase.keys(), ...declHead.keys()])) {
    if (direct.has(name)) continue;
    const before = declBase.get(name);
    const after = declHead.get(name);
    if (before && after && before.spec === after.spec) continue;
    if (!before && !after) continue;
    const decl = after ?? before;
    if (!decl) continue;
    direct.set(name, {
      name,
      from: before?.spec ?? "(absent)",
      to: after?.spec ?? "(removed)",
      kind: decl.kind,
      updateType: before && after ? classifyUpdate(before.spec, after.spec) : "unknown",
      locations: decl.locations,
    });
  }

  return {
    direct: [...direct.values()].toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    transitives: transitives.toSorted(),
    lockfileResolved,
    changedFiles,
  };
}
