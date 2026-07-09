import { changedPaths, diffNumstat, refExists } from "./git.ts";

/**
 * Fixer-path scope gate. The deterministic bump owns all dependency state
 * (manifests, lockfiles, pnpm-workspace.yaml catalogs), applied and committed
 * before the fixer runs; the fixer is source-fix-only. Its job is to edit source
 * — and, where a changed API demands it, tests — until verification passes, so
 * ANY change to dependency state can only be scope creep and is denied. The
 * agent is instructed to stay in bounds, but a poisoned changelog can override
 * instructions, so the boundary is enforced deterministically here before
 * anything the fixer wrote is committed.
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

/**
 * Every package-manager lockfile depvisor knows (the union across pm.ts's per-PM
 * lockfile sets) plus pnpm's workspace/catalog file. The fixer gate denies them
 * all regardless of the detected PM — the deterministic bump owns dependency
 * state, so a lockfile the fixer touched can only be scope creep. pnpm-workspace
 * .yaml is also in DENY (root-anchored); listing it here by basename additionally
 * catches a nested one. Keep in sync with pm.ts's lockfile sets.
 */
const FIXER_DENIED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
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
