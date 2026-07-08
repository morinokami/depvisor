import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
   * The concrete update command(s) the agent is instructed to run, scoped to
   * the workspaces that already declare each dependency (via each candidate's
   * `locations`). Built per group so a monorepo update touches only the right
   * manifests instead of adding dependencies to the root — see updater.md.
   *
   * `pinExact` makes the command resolve to exactly `candidate.latest`, at the
   * cost of an exact (range-less) manifest entry. Only bun's instruction
   * changes: bun writes the given specifier verbatim AND resolves a range at
   * install time, so its usual `@^<latest>` would let an install pull a
   * version newer than the one the minimum_release_age clamp chose. npm and
   * pnpm already install the exact target (their caret is written by the
   * tool, not resolved from a range), so they ignore the flag.
   */
  updateInstruction(candidates: readonly Candidate[], opts?: { pinExact?: boolean }): string;
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
   * two-commit split. The scope gate's catalog carve-out (scope.ts) is what
   * makes such a change legal; this list only routes it to the right commit.
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
 * npm update commands, one line per candidate, scoped with `-w <workspace>` to
 * exactly the workspaces that declare it (root — location "" — takes no `-w`).
 * A dependency present in both the root and a workspace yields two lines. `-D`
 * is added for dev-only dependencies to match the manifest section. `npm
 * install` (not `update`) is used because it reliably jumps to a specific
 * version regardless of the existing range; npm keeps an existing dependency in
 * its current section.
 */
function npmUpdateInstruction(candidates: readonly Candidate[]): string {
  const lines: string[] = [];
  for (const c of candidates) {
    const flag = c.kind === "dev" ? "-D " : "";
    const spec = `${c.name}@${c.latest}`;
    const workspaces = c.locations.filter((l) => l !== "");
    if (c.locations.includes("") || workspaces.length === 0) {
      lines.push(`npm install ${flag}${spec}`);
    }
    if (workspaces.length > 0) {
      lines.push(`npm install ${flag}${spec} ${workspaces.map((w) => `-w ${w}`).join(" ")}`);
    }
  }
  return instructionBlock(lines);
}

/**
 * pnpm needs only one recursive command: `pnpm -r update` reaches every
 * workspace (and the root) that declares each package, leaves the rest
 * untouched, and preserves each dependency's section — so no `-D` and no
 * per-workspace flags. `-r` also drives the single-package case correctly.
 *
 * Catalog-pinned dependencies are the exception, instructed as a hand edit of
 * pnpm-workspace.yaml: pnpm has no command that moves a catalog entry to a
 * SPECIFIC version — `pnpm update <name>@<ver>` DE-catalogs instead (it
 * rewrites each workspace's `catalog:` specifier to the plain version, leaving
 * the catalog entry stale), and `--latest` (which does edit the catalog since
 * pnpm 10.12.1) rejects version specs (ERR_PNPM_LATEST_WITH_SPEC) — verified
 * on pnpm 11.9. `--no-frozen-lockfile` matters because CI=true flips pnpm's
 * install default to frozen, which would fail on the just-edited catalog. The
 * scope gate's catalog carve-out (scope.ts) deterministically confines the
 * edit to exactly these packages at exactly these versions. `pinExact` mirrors
 * bun's: a hand-written range is resolved fresh at install time, so under the
 * minimum_release_age cooldown the entry must be exact or the install could
 * reach back into the cooldown window.
 */
function pnpmUpdateInstruction(
  candidates: readonly Candidate[],
  opts?: { pinExact?: boolean },
): string {
  const specs = candidates.map((c) => `${c.name}@${c.latest}`).join(" ");
  const style = opts?.pinExact
    ? "write the exact target version, no ^ or ~ (a range would let the install resolve past the vetted version)"
    : "keeping the entry's existing range style (an entry `^1.0.0` becomes `^<target>`, an exact entry stays exact)";
  return (
    instructionBlock([`pnpm -r update ${specs}`]) +
    "\n\nException — catalog-pinned packages: where one of these packages is declared " +
    "with the `catalog:` protocol in a package.json, do NOT run the update command for " +
    "it, and never replace a `catalog:` specifier in a package.json with a plain " +
    "version. Instead edit that package's entry in the `catalog:`/`catalogs:` section " +
    `of pnpm-workspace.yaml to its target version listed above — ${style} — and then ` +
    "run `pnpm install --no-frozen-lockfile` once to refresh the lockfile. Change " +
    "nothing else in pnpm-workspace.yaml."
  );
}

/**
 * bun scopes an add with `--cwd <workspace-path>` (it has no `-w`/`--filter` for
 * add), so this emits one line per declaring workspace (root — location "" —
 * takes no `--cwd`). The explicit `^` matters: bun writes the given specifier
 * verbatim, so a bare `name@1.2.3` would pin exactly where npm/pnpm write a
 * caret range (verified against bun 1.3.14). Under `pinExact` that pinning is
 * the point: bun resolves `@^<latest>` at install time, which would silently
 * pull a release the minimum_release_age cooldown just rounded away.
 */
function bunUpdateInstruction(
  candidates: readonly Candidate[],
  opts?: { pinExact?: boolean },
): string {
  const lines: string[] = [];
  for (const c of candidates) {
    const flag = c.kind === "dev" ? "-d " : "";
    const spec = opts?.pinExact ? `${c.name}@${c.latest}` : `${c.name}@^${c.latest}`;
    for (const loc of c.locations) {
      lines.push(loc === "" ? `bun add ${flag}${spec}` : `bun add --cwd ${loc} ${flag}${spec}`);
    }
  }
  return instructionBlock(lines);
}

/** Frame concrete update commands as an instruction the agent runs verbatim. */
function instructionBlock(commands: string[]): string {
  return (
    "Update the dependencies by running exactly these commands (they touch only " +
    "the workspaces that already declare each package — never add a dependency to " +
    "another workspace or to the root):\n" +
    commands.map((c) => `    ${c}`).join("\n")
  );
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
  updateInstruction: npmUpdateInstruction,
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
  updateInstruction: pnpmUpdateInstruction,
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
  updateInstruction: bunUpdateInstruction,
  lockfiles: BUN_LOCKFILES,
  // bun keeps catalogs in package.json (a guarded field, no carve-out yet), so
  // there is no extra manifest to route into the bump commit.
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
