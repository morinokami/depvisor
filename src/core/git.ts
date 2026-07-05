import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Commit identity; github.ts uses the email to detect human commits. */
const AGENT_NAME = "depvisor";
// GitHub's noreply domain never delivers mail, and `[`/`]` are invalid in
// usernames, so no account can ever claim this address for attribution.
export const AGENT_EMAIL = "depvisor[bot]@users.noreply.github.com";

class GitError extends Error {}

/**
 * Prefix applied to every git invocation to disable local hooks.
 *
 * The scope gate only sees the working tree, not `.git/`, so an agent could
 * plant hooks there for later deterministic commits or pushes. Command-line
 * `-c` also overrides a planted `core.hooksPath`.
 */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** Return raw stdout; porcelain parsing needs leading spaces preserved. */
function run(repo: string, args: string[]): { code: number; out: string; err: string } {
  const res = spawnSync("git", [...NO_HOOKS, ...args], { cwd: repo, encoding: "utf8" });
  return { code: res.status ?? 1, out: res.stdout ?? "", err: (res.stderr ?? "").trim() };
}

/** Run git and throw on failure so later steps cannot continue on stale state. */
function git(repo: string, args: string[]): string {
  const res = run(repo, args);
  if (res.code !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed (exit ${res.code}): ${res.err || res.out.trim()}`,
    );
  }
  return res.out.trim();
}

/** Probe variant: a non-zero exit is an answer, not an error. */
function probe(repo: string, args: string[]): { code: number; out: string } {
  return run(repo, args);
}

/**
 * True only when `repo` is the ROOT of its own git repository. A plain
 * "inside a work tree" check is not enough: if the fixture's .git is missing,
 * the fixture directory is inside the depvisor repo, and branch/commit
 * operations would silently target depvisor itself.
 */
export function isRepoRoot(repo: string): boolean {
  const res = probe(repo, ["rev-parse", "--show-toplevel"]);
  const top = res.out.trim();
  if (res.code !== 0 || !top) return false;
  try {
    return realpathSync(top) === realpathSync(repo);
  } catch {
    return false;
  }
}

export function currentBranch(repo: string): string {
  return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Repo-local config entries whose keys match `keyPattern` (git lowercases
 * section and variable names in its output; subsections keep their case).
 * Values may hold secrets — callers must never log them.
 */
export function localConfigEntries(
  repo: string,
  keyPattern: string,
): { key: string; value: string }[] {
  // -z terminates entries with NUL and separates key from value with \n, so
  // values containing newlines cannot masquerade as extra entries.
  // --includes because actions/checkout v6+ persists the token in a separate
  // file referenced via include.path from the repo-local config; git does not
  // expand includes for --local by default, which would hide that credential.
  const res = probe(repo, ["config", "--local", "--includes", "-z", "--get-regexp", keyPattern]);
  if (res.code !== 0) return []; // no match — or no repo, which callers reject elsewhere
  const entries: { key: string; value: string }[] = [];
  for (const chunk of res.out.split("\0")) {
    if (!chunk) continue;
    const nl = chunk.indexOf("\n");
    // A key set without `= value` comes back with no separator.
    if (nl === -1) entries.push({ key: chunk, value: "" });
    else entries.push({ key: chunk.slice(0, nl), value: chunk.slice(nl + 1) });
  }
  return entries;
}

function branchExists(repo: string, name: string): boolean {
  return probe(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).code === 0;
}

export function refExists(repo: string, ref: string): boolean {
  return probe(repo, ["rev-parse", "--verify", "--quiet", ref]).code === 0;
}

export function revParse(repo: string, ref: string): string {
  return git(repo, ["rev-parse", ref]);
}

/** Contents of `path` at `ref`, or null when absent. Output stays untrimmed. */
export function fileAtRef(repo: string, ref: string, path: string): string | null {
  const res = probe(repo, ["show", `${ref}:${path}`]);
  return res.code === 0 ? res.out : null;
}

/** Return to base at the end of a clean run; dirty trees stay for inspection. */
export function tryCheckout(repo: string, ref: string): boolean {
  return probe(repo, ["checkout", ref]).code === 0;
}

/**
 * Create (or reset) `name` off `base` and check it out — a re-run rebuilds the
 * same branch rather than duplicating.
 */
export function ensureBranch(repo: string, name: string, base: string): void {
  git(repo, ["checkout", base]);
  if (branchExists(repo, name)) {
    git(repo, ["checkout", name]);
    git(repo, ["reset", "--hard", base]);
  } else {
    git(repo, ["checkout", "-b", name, base]);
  }
}

export function hasChanges(repo: string): boolean {
  return git(repo, ["status", "--porcelain"]).length > 0;
}

/**
 * Discard everything past `ref`: commits, tracked modifications, and untracked
 * files. Ignored files such as node_modules are left alone. Used after a defer
 * so a half-finished attempt cannot dirty-tree-block the next run.
 */
export function discardWorkPast(repo: string, ref: string): void {
  git(repo, ["reset", "--hard", ref]);
  git(repo, ["clean", "-fd"]);
}

/**
 * Reset the working tree to `base` between groups in a multi-PR run: force back
 * to the base commit and remove untracked files, discarding whatever the
 * previous group left behind (commits on its own branch — which stay reachable
 * via that branch ref — or a dirty tree after a failed verification). `-f`
 * because a failed group can leave conflicting tracked changes that a plain
 * `checkout` would refuse; `clean -fd` (no `-x`) removes untracked files but
 * keeps ignored ones like node_modules, which the reinstall that follows
 * restores to the base lockfile state. Goes through `git()` so `NO_HOOKS`
 * applies — `.git/` is attacker-writable.
 */
export function resetToBase(repo: string, base: string): void {
  git(repo, ["checkout", "-f", base]);
  git(repo, ["clean", "-fd"]);
}

/** Probe variant of hasChanges; a failing status counts as not clean. */
export function isClean(repo: string): boolean {
  const res = probe(repo, ["status", "--porcelain"]);
  return res.code === 0 && res.out.trim().length === 0;
}

/** Paths touched in the working tree (modified, added, deleted, renamed, untracked). */
export function changedPaths(repo: string): string[] {
  // Porcelain status is two chars and may start with a space (` M foo`), so
  // trimmed output would shift the first path by one character.
  const res = run(repo, ["status", "--porcelain"]);
  if (res.code !== 0) {
    throw new GitError(`git status --porcelain failed: ${res.err}`);
  }
  const out = res.out.replace(/\n+$/, "");
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4); // rename: keep the destination
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    paths.push(p);
  }
  return paths;
}

function hasStaged(repo: string): boolean {
  return probe(repo, ["diff", "--cached", "--quiet"]).code !== 0;
}

function commitStaged(repo: string, message: string): string {
  git(repo, [
    "-c",
    `user.email=${AGENT_EMAIL}`,
    "-c",
    `user.name=${AGENT_NAME}`,
    "commit",
    "-m",
    message,
  ]);
  return revParse(repo, "HEAD");
}

/**
 * The changed paths that make up the mechanical dependency bump: every
 * `package.json` (root or workspace) and the given package-manager lockfile(s),
 * matched by basename so nested workspace manifests are included without
 * enumerating workspaces. Feeds `commitPaths` for the first of the two commits;
 * the split is cosmetic (both commits land in the same PR), so this carries no
 * trust boundary.
 */
export function manifestBumpPaths(repo: string, lockfiles: readonly string[]): string[] {
  const lock = new Set(lockfiles);
  return changedPaths(repo).filter((p) => {
    const base = p.slice(p.lastIndexOf("/") + 1);
    return base === "package.json" || lock.has(base);
  });
}

/**
 * Stage changed paths from the given list and commit. The split keeps the
 * mechanical manifest bump separate from source fixes.
 */
export function commitPaths(repo: string, paths: string[], message: string): string | null {
  const changed = new Set(changedPaths(repo));
  const present = paths.filter((p) => changed.has(p));
  if (present.length === 0) return null;
  git(repo, ["add", "-A", "--", ...present]);
  if (!hasStaged(repo)) return null;
  return commitStaged(repo, message);
}

/** Stage everything remaining and commit. Returns sha, or null if tree was clean. */
export function commitAll(repo: string, message: string): string | null {
  git(repo, ["add", "-A"]);
  if (!hasStaged(repo)) return null;
  return commitStaged(repo, message);
}
