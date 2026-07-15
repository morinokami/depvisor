import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Package-manager detection and per-PM command table. The JS package semantics
 * are shared; only the concrete commands and lockfiles differ.
 *
 * Security invariant: detection runs ONCE, in preflight, against the checked-
 * out PR head tree — before any agent runs — and the result is pinned for the
 * whole run. Never re-detect after the agent has run: lockfiles are
 * agent-writable, so a post-agent detection would let the agent switch the
 * package manager (and thereby which commands the trusted steps execute). The
 * head tree itself is updater-written, which is exactly the artifact depvisor
 * exists to consume; what matters is that the AGENT can never influence the
 * detection.
 */

/** A package manager depvisor can name — supported or not. */
type PmName = "npm" | "pnpm" | "yarn" | "bun";

export interface PmToolchain {
  name: "npm" | "pnpm" | "bun";
  /** Shell command that runs a package.json script. */
  runScript(script: string): string;
  /** This PM's lockfile names — for detection, dep-diff, and error messages. */
  lockfiles: readonly string[];
  /**
   * Extra root manifests that carry dependency state beyond package.json.
   * pnpm: pnpm-workspace.yaml — a catalog-pinned update moves its
   * `catalog`/`catalogs` entry there, so the fixer prompt's manifest diff must
   * include it (`git.ts:manifestDiff`) and dep-diff resolves `catalog:`
   * specifiers through it.
   */
  extraManifestFiles: readonly string[];
  /**
   * Install command for `install_command: auto` and for the baseline/head
   * reinstalls, or null when the repo has no committed lockfile. Auto fails
   * closed there because a bare install would create a lockfile and dirty the
   * pre-agent tree; lockfile-less repos must set install_command explicitly.
   */
  installCommand(repoPath: string): string | null;
}

const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;
const PNPM_LOCKFILES = ["pnpm-lock.yaml"] as const;
// bun.lock is the textual default since bun 1.2; the legacy binary bun.lockb
// is still read (and both may coexist — bun.lock wins), so both count for
// detection and frozen installs.
const BUN_LOCKFILES = ["bun.lock", "bun.lockb"] as const;

/**
 * The union of every supported PM's lockfile names. scope.ts's fixer gate and
 * the dependency-state path classifier deny/claim them all regardless of the
 * detected PM, so a new PM's lockfiles added here extend both automatically.
 */
export const ALL_PM_LOCKFILES: readonly string[] = [
  ...NPM_LOCKFILES,
  ...PNPM_LOCKFILES,
  ...BUN_LOCKFILES,
];

/**
 * Lockfiles of package managers depvisor does NOT support but a developer's
 * machine may honor: yarn, and nub (nubjs — pnpm-compatible, but writes its own
 * `nub.lock` when no incumbent PM is present). The fixer scope gate denies these
 * too — "the updater owns ALL dependency state" must cover a lockfile the fixer
 * *creates*, or a poisoned fixer could smuggle resolutions into the repair
 * commit that the next `yarn install` / `nub install` treats as real.
 * Deliberately NOT part of detection: yarn.lock already fails detection closed
 * via the LOCKFILES table, and recognizing nub.lock there would change which
 * repos depvisor accepts (see #40 — nub support is a docs recipe, not a PM).
 */
export const UNSUPPORTED_PM_LOCKFILES: readonly string[] = ["yarn.lock", "nub.lock"];

export const npmToolchain: PmToolchain = {
  name: "npm",
  runScript: (script) => `npm run ${script}`,
  lockfiles: NPM_LOCKFILES,
  extraManifestFiles: [],
  installCommand: (repoPath) =>
    NPM_LOCKFILES.some((f) => existsSync(join(repoPath, f))) ? "npm ci" : null,
};

export const pnpmToolchain: PmToolchain = {
  name: "pnpm",
  runScript: (script) => `pnpm run ${script}`,
  lockfiles: PNPM_LOCKFILES,
  extraManifestFiles: ["pnpm-workspace.yaml"],
  installCommand: (repoPath) =>
    PNPM_LOCKFILES.some((f) => existsSync(join(repoPath, f)))
      ? "pnpm install --frozen-lockfile"
      : null,
};

export const bunToolchain: PmToolchain = {
  name: "bun",
  runScript: (script) => `bun run ${script}`,
  lockfiles: BUN_LOCKFILES,
  // bun keeps catalogs in package.json, so there is no extra manifest.
  extraManifestFiles: [],
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
    const parsed: unknown = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || !("packageManager" in parsed)) return null;
    return typeof parsed.packageManager === "string" ? parsed.packageManager : null;
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
        "support yet — currently npm, pnpm, and bun. No verification or repair was " +
        "attempted, so nothing was changed.",
    };
  }
  return { ok: true, pm, source };
}

/**
 * Detect the target repo's package manager. The `packageManager` field
 * (corepack's standard) wins when present; otherwise lockfiles decide;
 * otherwise npm, the ecosystem default. Multiple PMs' lockfiles without a
 * field to disambiguate is a refusal, not a guess — running the wrong PM's
 * install/verify would misattribute failures rather than fail cleanly.
 */
export function detectPackageManager(repoPath: string): PmDetection {
  const field = packageManagerField(repoPath);
  const named = field ? /^(npm|pnpm|yarn|bun)@/.exec(field) : null;
  const name = named?.[1];
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    return toolchainFor(name, `the packageManager field ("${field}")`);
  }

  const present = LOCKFILES.filter(([file]) => existsSync(join(repoPath, file)));
  const names = [...new Set(present.map(([, pmName]) => pmName))];
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
