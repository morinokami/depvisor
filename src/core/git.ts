import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Committer identity; github.ts uses the committer email to detect human commits. */
const AGENT_NAME = "depvisor";
// GitHub's noreply domain never delivers mail, and `[`/`]` are invalid in
// usernames, so no account can ever claim this address for attribution.
export const AGENT_EMAIL = "depvisor[bot]@users.noreply.github.com";
// The author, by contrast, must RESOLVE to a GitHub account: Vercel-class Git
// integrations refuse to build a PR whose commit author maps to no account
// (#46). github-actions[bot]'s canonical id-prefixed address resolves; the
// push-boundary guards in github.ts key on the committer (%ce), which stays the
// unclaimable AGENT_EMAIL sentinel — keeping that field unchanged is also what
// lets PR branches created before this split keep refreshing (their tips carry
// the sentinel in both fields).
const AGENT_AUTHOR = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";

class GitError extends Error {}

/**
 * Prefix applied to every git invocation to disable local hooks.
 *
 * The scope gate only sees the working tree, not `.git/`, so target lifecycle or
 * verification commands could plant hooks there for later deterministic commits
 * or pushes. Command-line `-c` also overrides a planted `core.hooksPath`.
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

/**
 * Snapshot of every ref under refs/ (heads, tags, remotes) → object sha. The
 * target's own scripts (install lifecycle, verification) run with the checkout's
 * .git reachable, so they can move ANY ref —
 * `git branch -f`, a tag, `update-ref` — not just HEAD. A moved ref is exactly
 * what the token-holding open-pr step would later push: it pushes every
 * payload's branch at the END of the run, so even an already-processed group's
 * branch is a live target. The workflow snapshots refs from trusted code
 * before each group's first untrusted execution (the group-boundary reinstall,
 * the baseline verification, and the bump's install all predate any agent),
 * maintains the snapshot across its own deliberate ref writes, and
 * verifies/restores against it at every boundary where untrusted code ran —
 * failure paths included (refDrift / restoreRefs).
 */
export function snapshotRefs(repo: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) refs.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return refs;
}

/** Refs that differ from `expected` — moved, created, or deleted. */
export function refDrift(repo: string, expected: ReadonlyMap<string, string>): string[] {
  const current = snapshotRefs(repo);
  const drift: string[] = [];
  for (const [ref, sha] of expected) {
    if (current.get(ref) !== sha) drift.push(ref);
  }
  for (const ref of current.keys()) {
    if (!expected.has(ref)) drift.push(ref);
  }
  return drift;
}

/**
 * Force the repository back to `expected`: every ref to its snapshot sha, extra
 * refs deleted, `branch` checked out, tracked tree reset and untracked files
 * cleaned. The order matters: refs are restored first so the checkout target is
 * guaranteed to exist even if an untrusted command deleted it; force-checkout then
 * reattaches HEAD (a plain `reset --hard` would move whatever branch the
 * that command left checked out — e.g. the base branch — instead of returning to
 * `branch`); extra refs are deleted only after HEAD is safely off them.
 */
export function restoreRefs(
  repo: string,
  expected: ReadonlyMap<string, string>,
  branch: string,
): void {
  for (const [ref, sha] of expected) {
    git(repo, ["update-ref", ref, sha]);
  }
  git(repo, ["checkout", "-f", branch]);
  for (const ref of snapshotRefs(repo).keys()) {
    if (!expected.has(ref)) git(repo, ["update-ref", "-d", ref]);
  }
  git(repo, ["clean", "-fd"]);
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
  // -z terminates entries with NUL and prints paths verbatim: without it, git
  // C-quotes any path with special bytes (`"\346…"` for non-ASCII, escaped
  // quotes/backslashes), and that escaped string no longer names the real file
  // — a `git add` pathspec built from it fails, and a scope-gate read of the
  // changed package.json sees nothing on either side. Entries are `XY path`
  // (two status chars and a space, so the output must not be trimmed); a
  // rename/copy entry is `XY destination\0original` — the original is consumed
  // and dropped, keeping the destination as before.
  //
  // --untracked-files=all lists every file under a NEW directory individually;
  // git's default collapses it to just `newdir/`. The fixer scope gate keys its
  // manifest deny on the exact `package.json` filename, so a collapsed
  // `packages/evil/` would let a fixer smuggle a new package.json with a
  // `postinstall`/`overrides` past the gate (the file is then committed by the
  // catch-all `commitAll`). `all` still omits gitignored paths (node_modules),
  // which are governed by --ignored, so this does not surface the install tree.
  const res = run(repo, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (res.code !== 0) {
    throw new GitError(`git status --porcelain failed: ${res.err}`);
  }
  const tokens = res.out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry) continue; // trailing NUL leaves a final empty token
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) i += 1; // skip the rename/copy ORIG_PATH
  }
  return paths;
}

/** Content-and-mode snapshot of every currently changed working-tree path. */
export type WorktreeSnapshot = Map<string, string>;

function pathFingerprint(repo: string, path: string): string {
  const full = join(repo, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return "missing";
    }
    throw err;
  }
  if (stat.isSymbolicLink()) return `link:${stat.mode}:${readlinkSync(full)}`;
  if (!stat.isFile()) return `other:${stat.mode}:${stat.size}`;

  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(full, "r");
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return `file:${stat.mode}:${stat.size}:${hash.digest("hex")}`;
}

/**
 * Snapshot the exact uncommitted state without staging anything. The fixer path
 * captures this immediately before the authoritative verification; any drift
 * afterward means the verification scripts authored extra changes and the
 * workflow must not fold them into the fix commit.
 */
export function snapshotWorktree(repo: string): WorktreeSnapshot {
  return new Map(
    changedPaths(repo)
      .toSorted()
      .map((path) => [path, pathFingerprint(repo, path)]),
  );
}

/** Paths added, removed, or content/mode-changed since `expected`. */
export function worktreeDrift(repo: string, expected: ReadonlyMap<string, string>): string[] {
  const current = snapshotWorktree(repo);
  const drift = new Set<string>();
  for (const [path, fingerprint] of expected) {
    if (current.get(path) !== fingerprint) drift.add(path);
  }
  for (const path of current.keys()) {
    if (!expected.has(path)) drift.add(path);
  }
  return [...drift].toSorted();
}

/** Per-file line-change counts for a committed diff. */
export interface NumstatEntry {
  /** Repo-relative path. */
  path: string;
  /** Added lines, or null for binary files (git prints `-`). */
  added: number | null;
  /** Removed lines, or null for binary files. */
  removed: number | null;
}

function parseNumstatNumber(value: string): number | null {
  return value === "-" ? null : Number(value);
}

/**
 * Per-file line counts for the committed diff `from..to`, parsed from
 * `git diff --numstat --no-renames -z`.
 *
 * `--no-renames` is deliberate. A moved file is reported as a delete of its old
 * path PLUS an add of the new one, never collapsed into one rename record.
 * Test-change visibility depends on this: moving `test/a.test.ts` to `src/a.ts`
 * drops the file out of the test globs (silently disabling the test), and only
 * the delete side carries the `test/…` path that must be flagged — a rename
 * record would surface just the non-test destination and the signal would be
 * lost. It also means a newly added test surfaces its own path.
 *
 * `-z` leaves paths unquoted/unmangled, so a filename with tabs, spaces, or
 * backticks arrives verbatim. Every record is `added\tremoved\tpath\0` (or
 * `-\t-\tpath\0` for binary → null counts); slicing past the second tab keeps a
 * tab that is part of the filename. Goes through `run()` (not `git()`, which
 * trims) so raw NULs survive, and throws on a non-zero exit so a failed diff
 * cannot masquerade as "no changes".
 */
export function diffNumstat(repo: string, from: string, to: string): NumstatEntry[] {
  const res = run(repo, ["diff", "--numstat", "--no-renames", "-z", from, to]);
  if (res.code !== 0) {
    throw new GitError(`git diff --numstat ${from} ${to} failed (exit ${res.code}): ${res.err}`);
  }
  const entries: NumstatEntry[] = [];
  for (const record of res.out.split("\0")) {
    if (record === "") continue; // trailing NUL leaves a final empty token
    const t1 = record.indexOf("\t");
    const t2 = t1 === -1 ? -1 : record.indexOf("\t", t1 + 1);
    if (t1 === -1 || t2 === -1) continue; // malformed record; skip rather than mis-slice
    entries.push({
      path: record.slice(t2 + 1),
      added: parseNumstatNumber(record.slice(0, t1)),
      removed: parseNumstatNumber(record.slice(t1 + 1, t2)),
    });
  }
  return entries;
}

/**
 * The textual diff (hunks) of `from..to` restricted to dependency MANIFESTS —
 * every package.json (root or workspace) plus the PM's extra root manifests
 * (`extraBumpFiles`, the same seam `manifestBumpPaths` uses: pnpm's
 * pnpm-workspace.yaml) — and nothing else. The fixer is shown these hunks so it
 * knows exactly what the deterministic bump changed, WITHOUT the lockfile hunks:
 * a pnpm-lock.yaml diff runs to thousands of lines and would swamp the fixer's
 * context (lockfiles reach it as numstat lines only, never hunks). The `:(glob)`
 * pathspec matches nested and root manifests alike. Goes through `run()` (not
 * `git()`, which trims) so hunk whitespace survives, and throws on a non-zero
 * exit so a failed diff cannot masquerade as an empty one.
 */
export function manifestDiff(
  repo: string,
  from: string,
  to: string,
  extraBumpFiles: readonly string[] = [],
): string {
  const res = run(repo, ["diff", from, to, "--", ":(glob)**/package.json", ...extraBumpFiles]);
  if (res.code !== 0) {
    throw new GitError(`git diff ${from} ${to} (manifests) failed (exit ${res.code}): ${res.err}`);
  }
  return res.out;
}

function hasStaged(repo: string): boolean {
  return probe(repo, ["diff", "--cached", "--quiet"]).code !== 0;
}

function commitStaged(repo: string, message: string): string {
  // `-c user.*` sets the committer (the guards' sentinel); `--author` overrides
  // only the author with the resolvable display identity.
  git(repo, [
    "-c",
    `user.email=${AGENT_EMAIL}`,
    "-c",
    `user.name=${AGENT_NAME}`,
    "commit",
    `--author=${AGENT_AUTHOR}`,
    "-m",
    message,
  ]);
  return revParse(repo, "HEAD");
}

/**
 * The changed paths that make up the mechanical dependency bump: every
 * `package.json` (root or workspace) and the given package-manager lockfile(s),
 * matched by basename so nested workspace manifests are included without
 * enumerating workspaces — plus the PM's extra root manifests (`extraBumpFiles`,
 * exact root paths: pnpm's pnpm-workspace.yaml, whose catalog entries a
 * catalog-pinned bump rewrites). Feeds `commitPaths` for the first of the two
 * commits; the split is cosmetic (both commits land in the same PR), so this
 * carries no trust boundary.
 */
export function manifestBumpPaths(
  repo: string,
  lockfiles: readonly string[],
  extraBumpFiles: readonly string[] = [],
): string[] {
  const lock = new Set(lockfiles);
  const extra = new Set(extraBumpFiles);
  return changedPaths(repo).filter((p) => {
    const base = p.slice(p.lastIndexOf("/") + 1);
    return base === "package.json" || lock.has(base) || extra.has(p);
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
