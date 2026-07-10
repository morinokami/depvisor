import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CatalogEdit, UpdatePlan } from "./bump.ts";
import type { Candidate } from "./types.ts";

/**
 * Package-manager detection and per-PM command table. The JS package semantics
 * are shared; only the concrete commands and lockfiles differ.
 *
 * Security invariant: detection runs ONCE, in preflight, against the trusted
 * base tree — before the agent — and the result is pinned for the whole run.
 * Never re-detect after the agent has run: lockfiles are agent-writable, so a
 * post-agent detection would let the agent switch the package manager (and
 * thereby which commands the trusted steps execute).
 */

/** A package manager depvisor can name — supported or not. */
type PmName = "npm" | "pnpm" | "yarn" | "bun";

export interface PmToolchain {
  name: "npm" | "pnpm" | "bun";
  /**
   * argv for the outdated check (spawned without a shell). npm and pnpm exit 1
   * when updates exist, with the JSON still on stdout; bun always exits 0 and
   * prints an ASCII table instead — it has no JSON mode (oven-sh/bun#15648),
   * so collect.ts parses the table fail-closed.
   */
  outdatedArgv: readonly [string, ...string[]];
  /** Shell command that runs a package.json script. */
  runScript(script: string): string;
  /**
   * The deterministic, per-PM, per-workspace update as an `UpdatePlan` the
   * executor (bump.ts) applies directly — so the installed version and the
   * manifest/branch identity are fixed by LLM-free code before any agent runs.
   * Scoped to the workspaces that already declare each dependency (via each
   * candidate's `locations`), so a monorepo update touches only the right
   * manifests instead of adding a dependency to the root. `repoPath` is consulted
   * only by pnpm, which reads pnpm-workspace.yaml to tell catalog-pinned members
   * (routed to `catalogEdits`, never the update command — the split `pnpm update`
   * cannot make) from plain ones; npm/bun ignore it.
   *
   * `pinExact` makes the update resolve to exactly `candidate.latest`, at the
   * cost of an exact (range-less) manifest/catalog entry where a PM would
   * otherwise write or resolve a range. It drops bun's caret (bun writes the
   * given specifier verbatim AND resolves ranges at install time) and forces
   * pnpm's catalog entries exact (a hand-written catalog range is resolved fresh
   * by the follow-up install); npm always installs the exact target, so it
   * ignores the flag.
   */
  updatePlan(
    candidates: readonly Candidate[],
    repoPath: string,
    opts?: { pinExact?: boolean },
  ): UpdatePlan;
  /**
   * This PM's lockfile names — for detection, error messages, and (with every
   * `package.json`) the mechanical bump commit of the two-commit split
   * (`git.ts`'s `manifestBumpPaths`).
   */
  lockfiles: readonly string[];
  /**
   * Extra root manifests a legitimate update may rewrite, for the mechanical
   * bump commit (exact root paths, not basenames). pnpm: pnpm-workspace.yaml —
   * a catalog-pinned bump moves its `catalog`/`catalogs` entry there, and
   * without this the version change would land in the "fix" commit of the
   * two-commit split. The change is legal because the deterministic bump
   * (bump.ts) owns and commits it before any agent runs — the fixer gate
   * denies the file outright; this list only routes it to the right commit.
   */
  extraBumpFiles: readonly string[];
  /**
   * Install command that does not create a lockfile — the escape hatch a
   * lockfile-less repo sets as its explicit install_command.
   * Only used in guidance messages; a bare `npm install`/`pnpm install`
   * would create the lockfile and dirty the pre-agent tree.
   * `null` when the PM has no such escape hatch: bun reads the committed
   * lockfile (not the installed tree) to compute outdated candidates, so a
   * lockfile-less bun repo cannot be updated at all — no install flag helps.
   */
  noLockfileInstall: string | null;
  /**
   * Install command for `install_command: auto`, or null when the repo has no
   * committed lockfile. Auto fails closed there because a bare install would
   * create a lockfile and dirty the pre-agent tree; lockfile-less repos must
   * set install_command explicitly.
   */
  installCommand(repoPath: string): string | null;
}

/**
 * npm update commands as argv, one per candidate, scoped with `-w <workspace>`
 * to exactly the workspaces that declare it (root — location "" — takes no
 * `-w`); a dependency present in both the root and a workspace yields two
 * commands. `-D` marks dev-only dependencies so they stay in devDependencies.
 * `npm install` (not `update`) is used because it reliably jumps to a specific
 * version regardless of the existing range, keeping the dependency in its
 * current section. npm has no catalogs, so `catalogEdits` is empty; `repoPath`
 * is unused and the plan only records `pinExact` (npm always installs the exact
 * target).
 */
function npmUpdatePlan(
  candidates: readonly Candidate[],
  _repoPath: string,
  opts?: { pinExact?: boolean },
): UpdatePlan {
  const commands: string[][] = [];
  for (const c of candidates) {
    const flag = c.kind === "dev" ? ["-D"] : [];
    const spec = `${c.name}@${c.latest}`;
    const workspaces = c.locations.filter((l) => l !== "");
    if (c.locations.includes("") || workspaces.length === 0) {
      commands.push(["npm", "install", ...flag, spec]);
    }
    if (workspaces.length > 0) {
      commands.push(["npm", "install", ...flag, spec, ...workspaces.flatMap((w) => ["-w", w])]);
    }
  }
  return { catalogEdits: [], commands, pinExact: opts?.pinExact ?? false };
}

/** A parsed JSON value that is a plain string→value map, else null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The package.json sections a dependency can be declared in. */
const PNPM_DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * Parse a declaring workspace's package.json (loc "" = repo root) as a plain
 * map, or null when it is missing/unparseable — which the caller treats as a
 * blocker (fail closed rather than guess how the dependency is pinned).
 */
function readWorkspaceManifest(repoPath: string, loc: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(join(repoPath, loc, "package.json"), "utf8")));
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
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const root = asRecord(raw);
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
function pnpmUpdatePlan(
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

  for (const c of candidates) {
    const referencedCatalogs = new Set<string | null>();
    let hasPlain = false;
    let unreadable = false;
    for (const loc of manifestDirs) {
      const pkg = readWorkspaceManifest(repoPath, loc);
      if (pkg === null) {
        unreadable = true;
        break;
      }
      for (const section of PNPM_DEP_SECTIONS) {
        const map = asRecord(pkg[section]);
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

/**
 * bun scopes an add with `--cwd <workspace-path>` (it has no `-w`/`--filter` for
 * add), so this emits one `bun add` argv per declaring workspace (root —
 * location "" — takes no `--cwd`), with `-d` for dev deps. The explicit `^`
 * matters: bun writes the given specifier verbatim, so a bare `name@1.2.3` would
 * pin exactly where npm/pnpm write a caret range (verified against bun 1.3.14).
 * Under `pinExact` the caret is dropped on purpose: bun resolves `@^<latest>` at
 * install time, which would silently pull a release the minimum_release_age
 * cooldown just rounded away — only the exact form is guaranteed to land on
 * candidate.latest. bun keeps catalogs in package.json, which this plan does not
 * edit (a bun-catalog bump is a recorded follow-up), so `catalogEdits` is empty
 * and `repoPath` is unused.
 */
function bunUpdatePlan(
  candidates: readonly Candidate[],
  _repoPath: string,
  opts?: { pinExact?: boolean },
): UpdatePlan {
  const commands: string[][] = [];
  for (const c of candidates) {
    const flag = c.kind === "dev" ? ["-d"] : [];
    const spec = opts?.pinExact ? `${c.name}@${c.latest}` : `${c.name}@^${c.latest}`;
    for (const loc of c.locations) {
      commands.push(
        loc === "" ? ["bun", "add", ...flag, spec] : ["bun", "add", "--cwd", loc, ...flag, spec],
      );
    }
  }
  return { catalogEdits: [], commands, pinExact: opts?.pinExact ?? false };
}

const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;
const PNPM_LOCKFILES = ["pnpm-lock.yaml"] as const;
// bun.lock is the textual default since bun 1.2; the legacy binary bun.lockb
// is still read (and both may coexist — bun.lock wins), so both count for
// detection, frozen installs, and the mechanical bump commit.
const BUN_LOCKFILES = ["bun.lock", "bun.lockb"] as const;

export const npmToolchain: PmToolchain = {
  name: "npm",
  // --long adds each entry's `type` (dependencies/devDependencies) and
  // `dependedByLocation` (the workspace path) — both needed to classify and
  // target workspace dependencies. See collect.ts's parseOutdated.
  outdatedArgv: ["npm", "outdated", "--json", "--long"],
  runScript: (script) => `npm run ${script}`,
  updatePlan: npmUpdatePlan,
  lockfiles: NPM_LOCKFILES,
  extraBumpFiles: [],
  noLockfileInstall: "npm install --package-lock=false",
  installCommand: (repoPath) =>
    NPM_LOCKFILES.some((f) => existsSync(join(repoPath, f))) ? "npm ci" : null,
};

export const pnpmToolchain: PmToolchain = {
  name: "pnpm",
  // -r reports workspace dependencies too (without it only the root package's
  // deps are visible); it also works for a single-package repo. See collect.ts.
  outdatedArgv: ["pnpm", "outdated", "-r", "--format", "json"],
  runScript: (script) => `pnpm run ${script}`,
  updatePlan: pnpmUpdatePlan,
  lockfiles: PNPM_LOCKFILES,
  // pnpm ≥ 10.12.1's `pnpm update` rewrites catalog entries here itself; the
  // composite action puts depvisor's own pinned pnpm on PATH, so CI always has
  // catalog-capable pnpm.
  extraBumpFiles: ["pnpm-workspace.yaml"],
  noLockfileInstall: "pnpm install --no-lockfile",
  installCommand: (repoPath) =>
    PNPM_LOCKFILES.some((f) => existsSync(join(repoPath, f)))
      ? "pnpm install --frozen-lockfile"
      : null,
};

export const bunToolchain: PmToolchain = {
  name: "bun",
  // -r reports workspace dependencies too and adds a Workspace column; it also
  // works for a single-package repo (Workspace = the package's own name). The
  // 4-column non-recursive form only ever reports the root package. See
  // collect.ts's parseBunOutdated.
  outdatedArgv: ["bun", "outdated", "-r"],
  runScript: (script) => `bun run ${script}`,
  updatePlan: bunUpdatePlan,
  lockfiles: BUN_LOCKFILES,
  // bun keeps catalogs in package.json (already a bump-commit path via the
  // basename match), so there is no extra manifest to route into the bump commit.
  extraBumpFiles: [],
  // No escape hatch: `bun outdated` reads the committed lockfile, not the
  // installed tree, so `bun install --no-save` (which writes no lockfile)
  // leaves it erroring with "missing lockfile" — a lockfile-less bun repo
  // simply cannot be updated. See noLockfileInstall's doc on PmToolchain.
  noLockfileInstall: null,
  installCommand: (repoPath) =>
    BUN_LOCKFILES.some((f) => existsSync(join(repoPath, f)))
      ? "bun install --frozen-lockfile"
      : null,
};

const TOOLCHAINS: Partial<Record<PmName, PmToolchain>> = {
  npm: npmToolchain,
  pnpm: pnpmToolchain,
  bun: bunToolchain,
};

/** Lockfile → PM, in detection order. */
const LOCKFILES: readonly [string, PmName][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

export type PmDetection =
  | { ok: true; pm: PmToolchain; source: string }
  | {
      ok: false;
      status: "unsupported-package-manager" | "ambiguous-package-manager";
      summary: string;
    };

function packageManagerField(repoPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    return typeof pkg.packageManager === "string" ? pkg.packageManager : null;
  } catch {
    return null;
  }
}

function toolchainFor(name: PmName, source: string): PmDetection {
  const pm = TOOLCHAINS[name];
  if (!pm) {
    return {
      ok: false,
      status: "unsupported-package-manager",
      summary:
        `This repository uses ${name} (detected via ${source}), which depvisor does not ` +
        "support yet — currently npm, pnpm, and bun. No update run was attempted, so " +
        "nothing half-updated was left behind.",
    };
  }
  return { ok: true, pm, source };
}

/**
 * Detect the target repo's package manager. The `packageManager` field
 * (corepack's standard) wins when present; otherwise lockfiles decide;
 * otherwise npm, the ecosystem default. Multiple PMs' lockfiles without a
 * field to disambiguate is a refusal, not a guess — running the wrong PM
 * produces a subtly broken PR (stale lockfile) rather than a clean failure.
 */
export function detectPackageManager(repoPath: string): PmDetection {
  const field = packageManagerField(repoPath);
  const named = field ? /^(npm|pnpm|yarn|bun)@/.exec(field) : null;
  if (named) {
    return toolchainFor(named[1] as PmName, `the packageManager field ("${field}")`);
  }

  const present = LOCKFILES.filter(([file]) => existsSync(join(repoPath, file)));
  const names = [...new Set(present.map(([, name]) => name))];
  if (names.length > 1) {
    return {
      ok: false,
      status: "ambiguous-package-manager",
      summary:
        `Lockfiles of multiple package managers found (${present.map(([f]) => f).join(", ")}) ` +
        "and no packageManager field in package.json to disambiguate. Refusing to guess; " +
        "remove the stale lockfile(s) or set the packageManager field.",
    };
  }
  const single = names[0];
  if (single !== undefined) {
    return toolchainFor(single, `its lockfile (${present[0]?.[0]})`);
  }
  return toolchainFor("npm", "the default (no lockfile or packageManager field found)");
}
