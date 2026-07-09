import { existsSync, readFileSync } from "node:fs";
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

/** A parsed YAML value that is a plain string→value map, else null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The catalog-pinned package names in a repo's pnpm-workspace.yaml: every key of
 * the top-level `catalog` map and of every named `catalogs.<group>` map. Read
 * with the plain `yaml` parser (the comment-preserving Document round-trip
 * belongs to the executor, bump.ts); a missing or unparseable file yields no
 * names, so those members fall to the ordinary update command — the executor's
 * catalog edit is where a genuinely catalog-pinned member with no entry fails
 * closed. "has an entry" is exactly the membership test the agent prompt uses.
 */
function pnpmCatalogNames(repoPath: string): Set<string> {
  const names = new Set<string>();
  let root: unknown;
  try {
    root = parseYaml(readFileSync(join(repoPath, "pnpm-workspace.yaml"), "utf8"));
  } catch {
    return names;
  }
  const map = asRecord(root);
  if (!map) return names;
  const catalog = asRecord(map.catalog);
  if (catalog) for (const name of Object.keys(catalog)) names.add(name);
  const catalogs = asRecord(map.catalogs);
  if (catalogs) {
    for (const group of Object.values(catalogs)) {
      const groupMap = asRecord(group);
      if (groupMap) for (const name of Object.keys(groupMap)) names.add(name);
    }
  }
  return names;
}

/**
 * pnpm needs only one recursive command for plain members: `pnpm -r update`
 * reaches every workspace (and the root) that declares each package, leaves the
 * rest untouched, and preserves each dependency's section — so no `-D` and no
 * per-workspace flags. `-r` also drives the single-package case correctly.
 *
 * Catalog-pinned members (those with a pnpm-workspace.yaml catalog entry) are
 * the exception: they become `catalogEdits` and are excluded from the command,
 * because pnpm has no command that moves a catalog entry to a SPECIFIC version —
 * `pnpm update <name>@<ver>` DE-catalogs instead (rewriting each workspace's
 * `catalog:` specifier to the plain version and leaving the catalog entry stale),
 * and `--latest` (which does edit the catalog since pnpm 10.12.1) rejects version
 * specs (ERR_PNPM_LATEST_WITH_SPEC) — both verified on pnpm 11.9. The executor
 * (bump.ts) applies the catalog edits through the yaml Document API, then a
 * `pnpm install --no-frozen-lockfile` refreshes the lockfile (CI=true flips
 * pnpm's install default to frozen, which would reject the just-edited catalog).
 */
function pnpmUpdatePlan(
  candidates: readonly Candidate[],
  repoPath: string,
  opts?: { pinExact?: boolean },
): UpdatePlan {
  const catalogNames = pnpmCatalogNames(repoPath);
  const catalogEdits: CatalogEdit[] = [];
  const updateSpecs: string[] = [];
  for (const c of candidates) {
    if (catalogNames.has(c.name)) catalogEdits.push({ name: c.name, target: c.latest });
    else updateSpecs.push(`${c.name}@${c.latest}`);
  }
  const commands: string[][] = [];
  if (updateSpecs.length > 0) commands.push(["pnpm", "-r", "update", ...updateSpecs]);
  if (catalogEdits.length > 0) commands.push(["pnpm", "install", "--no-frozen-lockfile"]);
  return { catalogEdits, commands, pinExact: opts?.pinExact ?? false };
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
