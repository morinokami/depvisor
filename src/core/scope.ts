import { changedPaths, diffNumstat, refExists } from "./git.ts";
import { ALL_PM_LOCKFILES, UNSUPPORTED_PM_LOCKFILES } from "./pm.ts";

/**
 * The scope vocabulary that bounds the repair, in two halves of one rule:
 * the UPDATER owns all dependency state, and the FIXER may touch none of it.
 *
 * - `isDependencyStatePath` names the files a dependency updater legitimately
 *   writes (manifests, lockfiles, pnpm's workspace/catalog file). The workflow
 *   uses it to decide whether a PR is a pure dependency-update PR at all: a
 *   non-depvisor commit touching anything else means the PR carries work
 *   depvisor must not build a repair on (`not-an-update-pr`).
 * - `checkFixScope` runs on everything the fixer changed relative to the head
 *   commit it started from, and denies ANY dependency state plus every
 *   execution-surface config path — the fixer repairs source and tests only.
 *
 * Both are enforced deterministically because a poisoned changelog can
 * override the agent's instructions.
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
  /^pnpm-workspace\.yaml$/, // pnpm settings + catalogs — owned by the updater, not the fixer
  /^\.yarn\//, // yarn plugins/releases are executable JS
  /(^|\/)bunfig\.toml$/,
];

function isPackageJson(p: string): boolean {
  return p === "package.json" || p.endsWith("/package.json");
}

/** The root pnpm-workspace.yaml path (settings + catalogs). */
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * Every package-manager lockfile depvisor knows (pm.ts's `ALL_PM_LOCKFILES` —
 * derived, so a new PM's lockfiles extend this automatically — plus the
 * `UNSUPPORTED_PM_LOCKFILES` other tools honor even though depvisor never runs
 * them) plus pnpm's workspace/catalog file, matched by basename.
 */
const DEPENDENCY_STATE_FILES = new Set([
  ...ALL_PM_LOCKFILES,
  ...UNSUPPORTED_PM_LOCKFILES,
  PNPM_WORKSPACE_FILE,
]);

/**
 * Whether a repo-relative path is dependency state — the files a dependency
 * updater's commit legitimately writes and the fixer must never touch: any
 * package.json (root or workspace), any known PM lockfile (by basename, so
 * workspace-nested lockfiles count), and pnpm-workspace.yaml.
 */
export function isDependencyStatePath(p: string): boolean {
  if (isPackageJson(p)) return true;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return DEPENDENCY_STATE_FILES.has(base);
}

/**
 * The repair scope rule over a plain path list: DENY-list execution surfaces
 * and all dependency state. `checkFixScope` applies it to the working tree in
 * the tokenless step; the token-holding publish step re-applies it to the
 * repair commits' committed diff at the exit boundary (the payload is an
 * untrusted read-back there).
 */
export function repairScopeViolations(paths: Iterable<string>): string[] {
  const violations: string[] = [];
  for (const p of paths) {
    if (DENY.some((re) => re.test(p))) violations.push(p);
    else if (isDependencyStatePath(p)) violations.push(p);
  }
  return violations;
}

/**
 * The scope gate for the fixer's changes: everything the fixer altered relative
 * to `sinceRef` — the PR head commit, already HEAD when the fixer starts —
 * must be source or tests. Any DENY-list path and any dependency-state path is
 * a violation (fail-closed), because the updater already owns every legitimate
 * dependency-state change. Tests stay the one surface a scope gate cannot deny
 * (adapting a test to a changed API is legitimate; test-changes.ts handles
 * them by visibility instead).
 *
 * The path set is the working-tree diff against `sinceRef`: `changedPaths`
 * (working tree vs HEAD, with --untracked-files=all so a new dir's files are
 * listed individually — see git.ts) UNION any change committed between `sinceRef`
 * and HEAD. Normally sinceRef IS HEAD (the fixer edits the working tree and the
 * workflow commits afterward), so the union adds nothing; folding it in keeps the
 * gate correct if HEAD ever advances past the head commit.
 */
export function checkFixScope(
  repo: string,
  sinceRef: string,
): { ok: boolean; violations: string[] } {
  const paths = new Set(changedPaths(repo));
  if (sinceRef !== "HEAD" && refExists(repo, sinceRef) && refExists(repo, "HEAD")) {
    for (const entry of diffNumstat(repo, sinceRef, "HEAD")) paths.add(entry.path);
  }
  const violations = repairScopeViolations(paths);
  return { ok: violations.length === 0, violations };
}
