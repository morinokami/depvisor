import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CatalogEdit, UpdatePlan } from "./bump.ts";
import { asPlainMap, DEPENDENCY_FIELDS } from "./manifest.ts";
import type { Candidate } from "./types.ts";

/**
 * The pnpm update planner — the awkward member of pm.ts's per-PM command
 * table, split out because pnpm alone must enumerate every workspace and
 * classify catalog vs plain declarations before it can plan a deterministic
 * update; npm's and bun's planners are a handful of argv lines each and stay
 * inline in pm.ts. `pnpmToolchain` (pm.ts) is the only consumer, and the
 * pinned-detection security invariant documented there covers this module
 * too: everything here reads the trusted base tree, pre-agent.
 */

/**
 * Parse a declaring workspace's package.json (loc "" = repo root) as a plain
 * map, or null when it is missing/unparseable — which the caller treats as a
 * blocker (fail closed rather than guess how the dependency is pinned).
 */
function readWorkspaceManifest(repoPath: string, loc: string): Record<string, unknown> | null {
  try {
    return asPlainMap(JSON.parse(readFileSync(join(repoPath, loc, "package.json"), "utf8")));
  } catch {
    return null;
  }
}

/**
 * How a workspace references a dependency's version: a plain range, or a
 * `catalog:`/`catalog:<name>` reference into pnpm-workspace.yaml. `catalog` is
 * null for the DEFAULT catalog (a bare `catalog:`, pnpm's sugar for
 * `catalog:default`) and the name for a named one.
 */
function classifyPnpmSpecifier(spec: string): { catalog: string | null } | "plain" {
  if (spec === "catalog:") return { catalog: null };
  if (spec.startsWith("catalog:")) return { catalog: spec.slice("catalog:".length) };
  return "plain";
}

/**
 * Split a pnpm-workspace.yaml `packages` pattern into path segments, or null
 * when a segment uses glob syntax beyond what depvisor expands: only literals,
 * `*` (exactly one level), and `**` (any depth) are supported — `?`, character
 * classes, braces, and partial wildcards (`pkg-*`) are not. Enumeration feeds a
 * fail-closed classification, so an inexpandable pattern must surface as a
 * blocker, never as a silently smaller workspace set.
 */
function patternSegments(pattern: string): string[] | null {
  // pnpm accepts the common `./packages/*` spelling as equivalent to
  // `packages/*`. Normalize every leading `./` before matching repo-relative
  // directory parts; treating `.` as a literal segment silently enumerates no
  // workspaces and can misclassify a catalog declaration as plain.
  let normalized = pattern;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return [];
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  const segments = normalized.split("/").filter(Boolean);
  for (const s of segments) {
    if (s === "*" || s === "**") continue;
    if (/[*?[\]{}()]/.test(s)) return null;
  }
  return segments;
}

/** Whether a directory path (split into parts) matches a supported pattern. */
function dirMatches(parts: readonly string[], segments: readonly string[]): boolean {
  const m = (pi: number, si: number): boolean => {
    if (si === segments.length) return pi === parts.length;
    const s = segments[si];
    if (s === "**") {
      for (let k = pi; k <= parts.length; k++) if (m(k, si + 1)) return true;
      return false;
    }
    if (pi >= parts.length) return false;
    if (s !== "*" && s !== parts[pi]) return false;
    return m(pi + 1, si + 1);
  };
  return m(0, 0);
}

/** All directories under repoPath up to `depth` levels (null = unbounded),
 * repo-relative, skipping node_modules and dot-directories. */
function listDirs(repoPath: string, rel: string, depth: number | null, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(join(repoPath, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
    const child = rel === "" ? e.name : `${rel}/${e.name}`;
    out.push(child);
    if (depth === null || depth > 1) {
      listDirs(repoPath, child, depth === null ? null : depth - 1, out);
    }
  }
}

/**
 * Every workspace directory pnpm-workspace.yaml's `packages` patterns declare
 * (repo-relative; the root is NOT included — callers add it), or null when the
 * set cannot be enumerated faithfully (unparseable file, non-string patterns,
 * unsupported glob syntax). The declaration classification below must see EVERY
 * workspace manifest: `Candidate.locations` cannot be its source for pnpm,
 * because `pnpm outdated` reports only the highest installed version and omits
 * lower-versioned workspaces entirely (see collect.ts) — a plain declaration in
 * an omitted workspace would silently produce a catalog-only plan that never
 * updates it, while the PR claims it did. A missing pnpm-workspace.yaml is a
 * single-package repo: no workspaces, not an error. Negations (`!pattern`)
 * subtract from the matched set; only directories that actually contain a
 * package.json count as workspaces.
 */
function pnpmWorkspaceDirs(repoPath: string): string[] | null {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(join(repoPath, "pnpm-workspace.yaml"), "utf8"));
  } catch (err) {
    return err && typeof err === "object" && "code" in err && err.code === "ENOENT" ? [] : null;
  }
  const root = asPlainMap(raw);
  if (raw !== null && raw !== undefined && !root) return null;
  const patterns = root?.packages;
  if (patterns === undefined || patterns === null) return [];
  if (!Array.isArray(patterns) || !patterns.every((p): p is string => typeof p === "string")) {
    return null;
  }

  const positives: string[][] = [];
  const negatives: string[][] = [];
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const segments = patternSegments(negated ? pattern.slice(1) : pattern);
    if (segments === null) return null;
    (negated ? negatives : positives).push(segments);
  }

  const unbounded = positives.some((segs) => segs.includes("**"));
  const depth = unbounded ? null : Math.max(0, ...positives.map((segs) => segs.length));
  const dirs: string[] = [];
  listDirs(repoPath, "", depth, dirs);
  return dirs.filter((dir) => {
    const parts = dir.split("/");
    return (
      positives.some((segs) => dirMatches(parts, segs)) &&
      !negatives.some((segs) => dirMatches(parts, segs)) &&
      existsSync(join(repoPath, dir, "package.json"))
    );
  });
}

/**
 * pnpm needs only one recursive command for plain members: `pnpm -r update`
 * reaches every workspace (and the root) that declares each package, leaves the
 * rest untouched, and preserves each dependency's section — so no `-D` and no
 * per-workspace flags. `-r` also drives the single-package case correctly.
 *
 * Catalog-pinned members are the exception: they become `catalogEdits` and are
 * excluded from the command, because pnpm has no command that moves a catalog
 * entry to a SPECIFIC version — `pnpm update <name>@<ver>` DE-catalogs instead
 * (rewriting each workspace's `catalog:` specifier to the plain version and
 * leaving the catalog entry stale), and `--latest` (which does edit the catalog
 * since pnpm 10.12.1) rejects version specs (ERR_PNPM_LATEST_WITH_SPEC) — both
 * verified on pnpm 11.9. The executor (bump.ts) applies the catalog edits through
 * the yaml Document API, then a `pnpm install --no-frozen-lockfile` refreshes the
 * lockfile (CI=true flips pnpm's install default to frozen, which would reject
 * the just-edited catalog).
 *
 * Which members are catalog-pinned is decided by reading how each workspace's
 * package.json actually references the dependency — NOT a name-global scan of
 * pnpm-workspace.yaml's catalog keys (which mis-handles a dead catalog entry,
 * duplicate entries across named catalogs, and mixed references), and NOT from
 * `Candidate.locations` (incomplete for pnpm — see pnpmWorkspaceDirs). Every
 * workspace manifest, root included, is enumerated and inspected. Per candidate:
 * only plain references (or none found) → the recursive update, no catalog edit;
 * only catalog references → one `CatalogEdit` per DISTINCT catalog pointed at;
 * a mix of catalog and plain references across workspaces, or an unreadable
 * manifest, or an inexpandable workspace set → a `blocker` (fail-closed
 * `bump-failed`, since neither update mechanism would move every declaration
 * safely).
 */
export function pnpmUpdatePlan(
  candidates: readonly Candidate[],
  repoPath: string,
  opts?: { pinExact?: boolean },
): UpdatePlan {
  const catalogEdits: CatalogEdit[] = [];
  const updateSpecs: string[] = [];
  const blockers: string[] = [];
  const pinExact = opts?.pinExact ?? false;

  const workspaceDirs = pnpmWorkspaceDirs(repoPath);
  if (workspaceDirs === null) {
    return {
      catalogEdits,
      commands: [],
      pinExact,
      blockers: [
        "cannot enumerate the pnpm workspaces from pnpm-workspace.yaml's `packages` " +
          "patterns (unsupported glob syntax or an unparseable file) — refusing to " +
          "classify catalog vs plain declarations from an incomplete workspace set",
      ],
    };
  }
  const manifestDirs = ["", ...workspaceDirs];
  // One read per manifest, not one per candidate — the classification only
  // reads, so a multi-member group must not re-parse every workspace manifest
  // for each member.
  const manifests = new Map(
    manifestDirs.map((loc) => [loc, readWorkspaceManifest(repoPath, loc)] as const),
  );

  for (const c of candidates) {
    const referencedCatalogs = new Set<string | null>();
    let hasPlain = false;
    let unreadable = false;
    for (const loc of manifestDirs) {
      const pkg = manifests.get(loc) ?? null;
      if (pkg === null) {
        unreadable = true;
        break;
      }
      for (const section of DEPENDENCY_FIELDS) {
        const map = asPlainMap(pkg[section]);
        const spec = map ? map[c.name] : undefined;
        if (typeof spec !== "string") continue;
        const classified = classifyPnpmSpecifier(spec);
        if (classified === "plain") hasPlain = true;
        else referencedCatalogs.add(classified.catalog);
      }
    }

    if (unreadable) {
      blockers.push(
        `cannot read a workspace package.json while classifying ${c.name} — refusing to guess how it is pinned`,
      );
    } else if (referencedCatalogs.size === 0) {
      // Only plain declarations (or none found): the ordinary recursive update,
      // no catalog edit. A dead catalog entry with this name is left untouched.
      updateSpecs.push(`${c.name}@${c.latest}`);
    } else if (hasPlain) {
      // Mixed: `pnpm -r update` would de-catalog the catalog references and a
      // catalog-only edit would leave the plain declaration stale — neither is
      // safe, so fail closed rather than update half of them.
      blockers.push(
        `${c.name} is declared both as a catalog reference and a plain version across ` +
          "workspaces; depvisor cannot update it deterministically (unify the declarations)",
      );
    } else {
      // Only catalog references: one edit per DISTINCT catalog they point at.
      for (const catalog of referencedCatalogs) {
        catalogEdits.push({ name: c.name, target: c.latest, catalog });
      }
    }
  }

  const commands: string[][] = [];
  if (updateSpecs.length > 0) commands.push(["pnpm", "-r", "update", ...updateSpecs]);
  if (catalogEdits.length > 0) commands.push(["pnpm", "install", "--no-frozen-lockfile"]);
  return {
    catalogEdits,
    commands,
    pinExact,
    ...(blockers.length > 0 ? { blockers } : {}),
  };
}
