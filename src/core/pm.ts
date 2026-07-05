import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  /** The update command the agent is instructed to use (one sentence). */
  updateInstruction: string;
  /**
   * Manifest + lockfile paths of this PM, for the mechanical bump commit of
   * the two-commit split.
   */
  manifests: readonly string[];
  /** This PM's lockfile names (for detection and error messages). */
  lockfiles: readonly string[];
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

const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;
const PNPM_LOCKFILES = ["pnpm-lock.yaml"] as const;
// bun.lock is the textual default since bun 1.2; the legacy binary bun.lockb
// is still read (and both may coexist — bun.lock wins), so both count for
// detection, frozen installs, and the mechanical bump commit.
const BUN_LOCKFILES = ["bun.lock", "bun.lockb"] as const;

export const npmToolchain: PmToolchain = {
  name: "npm",
  outdatedArgv: ["npm", "outdated", "--json"],
  runScript: (script) => `npm run ${script}`,
  updateInstruction:
    "Use `npm install <name>@<version>` (`npm install -D <name>@<version>` for dev dependencies).",
  manifests: ["package.json", "package-lock.json", "npm-shrinkwrap.json"],
  lockfiles: NPM_LOCKFILES,
  noLockfileInstall: "npm install --package-lock=false",
  installCommand: (repoPath) =>
    NPM_LOCKFILES.some((f) => existsSync(join(repoPath, f))) ? "npm ci" : null,
};

export const pnpmToolchain: PmToolchain = {
  name: "pnpm",
  outdatedArgv: ["pnpm", "outdated", "--format", "json"],
  runScript: (script) => `pnpm run ${script}`,
  updateInstruction:
    "Use `pnpm add <name>@<version>` (`pnpm add -D <name>@<version>` for dev dependencies).",
  manifests: ["package.json", "pnpm-lock.yaml"],
  lockfiles: PNPM_LOCKFILES,
  noLockfileInstall: "pnpm install --no-lockfile",
  installCommand: (repoPath) =>
    PNPM_LOCKFILES.some((f) => existsSync(join(repoPath, f)))
      ? "pnpm install --frozen-lockfile"
      : null,
};

export const bunToolchain: PmToolchain = {
  name: "bun",
  outdatedArgv: ["bun", "outdated"],
  runScript: (script) => `bun run ${script}`,
  // The explicit `^` matters: bun preserves the given specifier verbatim, so a
  // bare `bun add name@1.2.3` would write an exact pin where npm/pnpm write a
  // caret range (verified against bun 1.3.14).
  updateInstruction:
    "Use `bun add <name>@^<version>` (`bun add -d <name>@^<version>` for dev dependencies).",
  manifests: ["package.json", "bun.lock", "bun.lockb"],
  lockfiles: BUN_LOCKFILES,
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
