import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedPaths,
  createRepairBundle,
  changedPathsInCommit,
  checkoutDetached,
  checkoutForce,
  commitAll,
  commitsInRange,
  currentBranch,
  diffNumstat,
  discardWorkPast,
  isRepoRoot,
  localConfigEntries,
  lsTreePaths,
  manifestDiff,
  mergeBase,
  refDrift,
  refExists,
  restoreRefs,
  revParse,
  snapshotRefs,
  snapshotWorktree,
  worktreeDrift,
} from "../src/core/git.ts";

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-git-"));
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  sh("git init -q");
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, "src.ts"), "export {};\n");
  sh("git add -A");
  sh("git -c user.email=t@t -c user.name=t commit -qm init");
  return repo;
}

test("isRepoRoot accepts only the top of an own repo, not subdirectories", () => {
  const repo = tempRepo();
  assert.equal(isRepoRoot(repo), true);
  // A subdirectory is "inside a work tree" but must not count as a target repo —
  // operating there would silently hit the parent repo.
  execSync("mkdir -p sub", { cwd: repo });
  assert.equal(isRepoRoot(join(repo, "sub")), false);
});

test("refExists probes branches without throwing", () => {
  const repo = tempRepo();
  assert.equal(refExists(repo, "HEAD"), true);
  assert.equal(refExists(repo, "missing-base"), false);
  execSync("git branch missing-base", { cwd: repo });
  assert.equal(refExists(repo, "missing-base"), true);
});

test("localConfigEntries reads matching repo-local keys, including include.path files", () => {
  const repo = tempRepo();
  assert.deepEqual(localConfigEntries(repo, "^http\\."), []);
  execSync('git config --local http.extraheader "AUTHORIZATION: basic abc"', { cwd: repo });
  assert.deepEqual(localConfigEntries(repo, "^http\\."), [
    { key: "http.extraheader", value: "AUTHORIZATION: basic abc" },
  ]);
  // actions/checkout v6+ persists the token in a separate file referenced via
  // include.path; --includes must expand it or the credential stays hidden.
  writeFileSync(
    join(repo, ".git/extra-config"),
    "[http]\n\textraheader = AUTHORIZATION: basic xyz\n",
  );
  execSync("git config --local include.path extra-config", { cwd: repo });
  const values = localConfigEntries(repo, "^http\\.").map((e) => e.value);
  assert.ok(values.includes("AUTHORIZATION: basic xyz"), "included credential must surface");
});

test("changedPaths does not truncate the first entry (leading-space status)", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, "package-lock.json"), '{"changed":1}\n');
  writeFileSync(join(repo, "package.json"), '{"changed":1}\n');
  // package-lock.json sorts first; a trimmed porcelain parse used to return
  // 'ackage-lock.json' here and silently drop it from the commit.
  assert.deepEqual(changedPaths(repo), ["package-lock.json", "package.json"]);
});

test("changedPaths reports quoting-triggering paths verbatim and they stay committable", () => {
  const repo = tempRepo();
  // Non-ASCII and embedded-quote names make non-`-z` porcelain C-quote the path
  // (`"\346…"`); the escaped string no longer names the real file, so a commit
  // pathspec built from it failed and a scope read saw nothing on either side.
  // `-z` prints paths verbatim.
  mkdirSync(join(repo, "ワークスペース"));
  writeFileSync(join(repo, "ワークスペース/package.json"), '{"name":"ws"}\n');
  writeFileSync(join(repo, 'has"quote.txt'), "x\n");
  execSync("git add -A", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit -qm add", { cwd: repo });

  writeFileSync(join(repo, "ワークスペース/package.json"), '{"name":"ws","version":"2"}\n');
  writeFileSync(join(repo, 'has"quote.txt'), "y\n");
  assert.deepEqual(changedPaths(repo).toSorted(), ['has"quote.txt', "ワークスペース/package.json"]);

  // The repair path must reach the commit, not die on a pathspec.
  const sha = commitAll(repo, "fix: adapt");
  assert.ok(sha);
  assert.deepEqual(changedPaths(repo), []);
});

test("changedPaths lists files under a new untracked directory individually, not collapsed", () => {
  const repo = tempRepo();
  // git collapses a brand-new untracked dir to `pkgs/` by default, which would
  // hide the package.json inside from the scope gate's basename check.
  mkdirSync(join(repo, "pkgs/evil"), { recursive: true });
  writeFileSync(join(repo, "pkgs/evil/package.json"), '{"name":"evil"}\n');
  writeFileSync(join(repo, "pkgs/evil/index.js"), "module.exports = 1;\n");
  assert.deepEqual(changedPaths(repo).toSorted(), ["pkgs/evil/index.js", "pkgs/evil/package.json"]);
});

test("changedPaths keeps only the destination of a staged rename (-z ORIG_PATH dropped)", () => {
  const repo = tempRepo();
  execSync("git mv src.ts renamed.ts", { cwd: repo });
  writeFileSync(join(repo, "package.json"), '{"changed":1}\n');
  assert.deepEqual(changedPaths(repo).toSorted(), ["package.json", "renamed.ts"]);
});

test("commitAll commits everything remaining and returns null on a clean tree", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, "src.ts"), "export const fixed = true;\n");
  writeFileSync(join(repo, "stray.ts"), "export {};\n");
  const fix = commitAll(repo, "fix: adapt");
  assert.ok(fix);
  const files = execSync("git show --name-only --format=", { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(files.toSorted(), ["src.ts", "stray.ts"]);
  // Nothing left → null on a second call.
  assert.equal(commitAll(repo, "x"), null);
});

test("commits split identity: resolvable author, unclaimable sentinel committer", () => {
  // Vercel-class Git integrations resolve the AUTHOR to a GitHub account and
  // refuse to build when it maps to none (#46), so the author must resolve;
  // the push-boundary guards key on the COMMITTER, which must stay unclaimable.
  const repo = tempRepo();
  writeFileSync(join(repo, "src.ts"), "export const fixed = true;\n");
  assert.ok(commitAll(repo, "fix: adapt"));
  const [authorName, authorEmail, committerName, committerEmail] = execSync(
    "git log -1 --format=%an%n%ae%n%cn%n%ce",
    { cwd: repo, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.equal(authorName, "github-actions[bot]");
  assert.equal(authorEmail, "41898282+github-actions[bot]@users.noreply.github.com");
  assert.equal(committerName, "depvisor");
  assert.equal(committerEmail, "depvisor[bot]@users.noreply.github.com");
});

test("mergeBase resolves the fork point of a branchy repo and null for unrelated histories", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const base = revParse(repo, "HEAD");
  const main = currentBranch(repo);
  // The updater-PR shape: base advances while the PR branch diverges from the
  // fork point — the aftercare baseline anchor.
  sh("git checkout -qb dependabot/npm_and_yarn/lru-cache-11.0.0");
  writeFileSync(join(repo, "src.ts"), "export const updated = true;\n");
  sh("git -c user.email=t@t -c user.name=t commit -aqm bump");
  sh(`git checkout -q ${main}`);
  writeFileSync(join(repo, "package.json"), '{"advanced":true}\n');
  sh("git -c user.email=t@t -c user.name=t commit -aqm advance");

  assert.equal(mergeBase(repo, main, "dependabot/npm_and_yarn/lru-cache-11.0.0"), base);

  // An orphan branch shares no history — unrelated must be null, not a throw.
  sh("git checkout -q --orphan lonely");
  sh("git rm -rfq .");
  writeFileSync(join(repo, "other.ts"), "export {};\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm orphan");
  assert.equal(mergeBase(repo, main, "lonely"), null);
  assert.equal(mergeBase(repo, main, "no-such-ref"), null);
});

test("commitsInRange lists newest first with per-commit committer emails and parent counts", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const base = revParse(repo, "HEAD");

  // The committer email is set at commit time (-c user.email) — the field the
  // ownership classification keys on, never the author.
  writeFileSync(join(repo, "src.ts"), "export const one = 1;\n");
  sh("git -c user.email=one@example.com -c user.name=one commit -aqm c1");
  const c1 = revParse(repo, "HEAD");
  writeFileSync(join(repo, "src.ts"), "export const two = 2;\n");
  sh("git -c user.email=two@example.com -c user.name=two commit -aqm c2");
  const c2 = revParse(repo, "HEAD");

  const range = commitsInRange(repo, base, "HEAD");
  assert.deepEqual(range, [
    { sha: c2, committerEmail: "two@example.com", parents: [c1] },
    { sha: c1, committerEmail: "one@example.com", parents: [base] },
  ]);
  // An empty range is [], not a parse artifact.
  assert.deepEqual(commitsInRange(repo, "HEAD", "HEAD"), []);
});

test("commitsInRange reports a merge commit with both parents", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const base = revParse(repo, "HEAD");
  const main = currentBranch(repo);
  sh("git checkout -qb feature");
  writeFileSync(join(repo, "feature.ts"), "export {};\n");
  sh("git add -A && git -c user.email=f@example.com -c user.name=f commit -qm feature");
  sh(`git checkout -q ${main}`);
  writeFileSync(join(repo, "src.ts"), "export const main = 1;\n");
  sh("git -c user.email=m@example.com -c user.name=m commit -aqm main-work");
  sh("git -c user.email=merger@example.com -c user.name=m merge -q --no-ff --no-edit feature");

  const range = commitsInRange(repo, base, "HEAD");
  assert.equal(range.length, 3);
  // Newest first: the merge tops the list; >1 parents is the merge signal.
  const [merge] = range;
  assert.ok(merge);
  assert.equal(merge.sha, revParse(repo, "HEAD"));
  assert.equal(merge.committerEmail, "merger@example.com");
  assert.equal(merge.parents.length, 2);
  assert.deepEqual(
    range.slice(1).map((c) => c.parents.length),
    [1, 1],
  );
});

test("changedPathsInCommit lists a commit's paths verbatim relative to its first parent", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  writeFileSync(join(repo, "src.ts"), "export const changed = true;\n");
  writeFileSync(join(repo, "a b.txt"), "space in name\n"); // -z keeps it verbatim
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm change");
  assert.deepEqual(changedPathsInCommit(repo, revParse(repo, "HEAD")).toSorted(), [
    "a b.txt",
    "src.ts",
  ]);
});

test("changedPathsInCommit on a root commit lists everything (--root, not empty)", () => {
  // Without `--root`, git diff-tree prints NOTHING for a parentless commit —
  // which would vacuously pass the "touches only dependency-state paths"
  // classification (fail-open). The flag makes a root commit list its whole
  // tree instead.
  const repo = tempRepo();
  const root = execSync("git rev-list --max-parents=0 HEAD", {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  assert.deepEqual(changedPathsInCommit(repo, root).toSorted(), [
    "package-lock.json",
    "package.json",
    "src.ts",
  ]);
});

test("lsTreePaths lists every tracked path at a ref, nested and non-ASCII included", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const first = revParse(repo, "HEAD");
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  writeFileSync(join(repo, "packages/a/package.json"), "{}\n");
  mkdirSync(join(repo, "ワークスペース"));
  writeFileSync(join(repo, "ワークスペース/index.ts"), "export {};\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm ws");

  assert.deepEqual(lsTreePaths(repo, "HEAD").toSorted(), [
    "package-lock.json",
    "package.json",
    "packages/a/package.json",
    "src.ts",
    "ワークスペース/index.ts",
  ]);
  // Older refs answer for their own tree, not the working tree.
  assert.deepEqual(lsTreePaths(repo, first).toSorted(), [
    "package-lock.json",
    "package.json",
    "src.ts",
  ]);
});

test("checkoutDetached/checkoutForce round-trip: detach onto the base, return to the branch", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const branch = currentBranch(repo);
  // node_modules is ignored; no -x in the clean, so install trees survive.
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm gitignore");
  const baseline = revParse(repo, "HEAD");
  writeFileSync(join(repo, "src.ts"), "export const tip = true;\n");
  sh("git -c user.email=t@t -c user.name=t commit -aqm tip");
  const tip = revParse(repo, "HEAD");

  // Leftovers a baseline run must not carry: a dirty tracked file, an untracked
  // stray, and an ignored install tree (which must be KEPT for the reinstall).
  writeFileSync(join(repo, "src.ts"), "export const dirty = true;\n");
  writeFileSync(join(repo, "stray.ts"), "export {};\n");
  mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules/pkg/index.js"), "module.exports = 1;\n");

  checkoutDetached(repo, baseline);
  assert.equal(revParse(repo, "HEAD"), baseline);
  // Detached — no branch ref moved to reach the baseline.
  assert.equal(sh("git rev-parse --abbrev-ref HEAD").trim(), "HEAD");
  assert.equal(sh("git status --porcelain").trim(), "");
  assert.ok(!existsSync(join(repo, "stray.ts")), "untracked files are cleaned");
  assert.ok(existsSync(join(repo, "node_modules/pkg/index.js")), "ignored files are kept");

  checkoutForce(repo, branch);
  assert.equal(sh("git rev-parse --abbrev-ref HEAD").trim(), branch);
  assert.equal(revParse(repo, "HEAD"), tip);
  assert.equal(sh("git status --porcelain").trim(), "");
});

test("discardWorkPast drops commits, tracked edits, and untracked files", () => {
  const repo = tempRepo();
  const head = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();

  // A deferred repair attempt may leave all three kinds of leftovers behind.
  writeFileSync(join(repo, "src.ts"), "export const halfDone = true;\n");
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm leftover", {
    cwd: repo,
  });
  writeFileSync(join(repo, "package.json"), '{"dirty":1}\n');
  writeFileSync(join(repo, "stray.ts"), "export {};\n");

  discardWorkPast(repo, head);

  assert.equal(execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim(), head);
  assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("diffNumstat parses normal, binary and awkward filenames, decomposing moves (--no-renames)", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const base = sh("git rev-parse --abbrev-ref HEAD").trim();
  // Seed a file to move and a binary blob at the base.
  writeFileSync(join(repo, "to-move.txt"), "old\nkeep\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm seed");

  sh("git checkout -q -b dependabot/npm_and_yarn/x");
  // Normal edit (2 added, 1 removed), a move with an edit, a binary change, and
  // filenames git can legitimately produce that would break naive markdown parsing.
  writeFileSync(join(repo, "src.ts"), "export const a = 1;\nexport const b = 2;\n");
  sh("git mv to-move.txt moved.txt");
  writeFileSync(join(repo, "moved.txt"), "old\nkeep\nappended\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  writeFileSync(join(repo, "a b.txt"), "x\n");
  writeFileSync(join(repo, "back`tick.txt"), "y\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm change");

  const byPath = new Map(diffNumstat(repo, base, "HEAD").map((e) => [e.path, e]));
  assert.deepEqual(byPath.get("src.ts"), { path: "src.ts", added: 2, removed: 1 });
  // Binary files report null counts (git prints "-").
  assert.deepEqual(byPath.get("blob.bin"), { path: "blob.bin", added: null, removed: null });
  // --no-renames: a move is a delete of the old path PLUS an add of the new one,
  // so BOTH sides surface (this is what keeps a moved-out test visible).
  assert.deepEqual(byPath.get("to-move.txt"), { path: "to-move.txt", added: 0, removed: 2 });
  assert.deepEqual(byPath.get("moved.txt"), { path: "moved.txt", added: 3, removed: 0 });
  // -z keeps unquoted paths verbatim, including spaces and backticks.
  assert.deepEqual(byPath.get("a b.txt"), { path: "a b.txt", added: 1, removed: 0 });
  assert.deepEqual(byPath.get("back`tick.txt"), { path: "back`tick.txt", added: 1, removed: 0 });
});

test("diffNumstat surfaces a test moved out of the test dir via its old path", () => {
  // The evasion this guards: renaming test/x.test.ts to src/x.ts drops it out of
  // the test globs (silently disabling the test) while verification still passes.
  // --no-renames means the delete of the test path is always emitted, so the
  // downstream classifier can still flag it — a rename record would have shown
  // only the non-test destination.
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const base = sh("git rev-parse --abbrev-ref HEAD").trim();
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "test/x.test.ts"), "assert(true);\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm seed");

  sh("git checkout -q -b dependabot/npm_and_yarn/x");
  mkdirSync(join(repo, "src"), { recursive: true });
  sh("git mv test/x.test.ts src/x.ts");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm 'move test out'");

  const paths = diffNumstat(repo, base, "HEAD")
    .map((e) => e.path)
    .toSorted();
  assert.deepEqual(paths, ["src/x.ts", "test/x.test.ts"]);
});

test("manifestDiff returns hunks for manifests only, never lockfiles or source", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  writeFileSync(join(repo, "packages/a/package.json"), `{"name":"a"}\n`);
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm ws");

  // An update touches root + nested manifests, pnpm-workspace.yaml, the lockfile,
  // and (say) source — only the first three should appear in the hunks.
  writeFileSync(join(repo, "package.json"), `{"dependencies":{"x":"2.0.0"}}\n`);
  writeFileSync(
    join(repo, "packages/a/package.json"),
    `{"name":"a","dependencies":{"y":"3.0.0"}}\n`,
  );
  writeFileSync(
    join(repo, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\ncatalog:\n  z: 1.0.0\n",
  );
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# churn\n");
  writeFileSync(join(repo, "src.ts"), "export const changed = true;\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm change");

  const diff = manifestDiff(repo, "HEAD~1", "HEAD", ["pnpm-workspace.yaml"]);
  assert.match(diff, /b\/package\.json/); // root manifest
  assert.match(diff, /b\/packages\/a\/package\.json/); // nested manifest
  assert.match(diff, /b\/pnpm-workspace\.yaml/);
  assert.match(diff, /catalog:/);
  // Lockfile diffs (thousands of lines) and source stay out — lockfiles reach
  // the fixer as numstat lines only, never hunks.
  assert.doesNotMatch(diff, /pnpm-lock\.yaml/);
  assert.doesNotMatch(diff, /src\.ts/);
});

test("diffNumstat returns [] for an empty diff", () => {
  const repo = tempRepo();
  const head = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  assert.deepEqual(diffNumstat(repo, head, "HEAD"), []);
});

test("commits ignore a planted .git/hooks/pre-commit (no local hooks run)", () => {
  const repo = tempRepo();
  // This hostile hook would abort the commit and drop a sentinel if hooks ran.
  const sentinel = join(repo, "hook-ran");
  writeFileSync(join(repo, ".git/hooks/pre-commit"), `#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`, {
    mode: 0o755,
  });
  writeFileSync(join(repo, "src.ts"), "export const x = 1;\n");

  const sha = commitAll(repo, "fix: adapt");
  assert.ok(sha, "commit must succeed despite the hostile pre-commit hook");
  assert.throws(() => execSync(`test -e "${sentinel}"`), "the pre-commit hook must not have run");
});

test("snapshotRefs/refDrift detect moved, created, and deleted refs", () => {
  const repo = tempRepo();
  execSync("git branch stable", { cwd: repo });
  const snapshot = snapshotRefs(repo);
  assert.deepEqual(refDrift(repo, snapshot), []);

  // Move an existing branch to a new commit, create a ref, delete nothing yet.
  writeFileSync(join(repo, "src.ts"), "export const x = 1;\n");
  execSync("git -c user.email=t@t -c user.name=t commit -qam evil", { cwd: repo });
  execSync("git branch -f stable HEAD", { cwd: repo });
  execSync("git tag sneaky", { cwd: repo });
  const drift = refDrift(repo, snapshot).toSorted();
  // The checked-out branch moved with the commit, stable was forced, sneaky created.
  assert.ok(drift.includes("refs/heads/stable"));
  assert.ok(drift.includes("refs/tags/sneaky"));
});

test("restoreRefs restores every ref, deletes extras, and reattaches the branch", () => {
  const repo = tempRepo();
  execSync("git branch -m main", { cwd: repo });
  execSync("git branch other-pr", { cwd: repo });
  execSync("git checkout -qb dependabot/npm_and_yarn/x", { cwd: repo });
  const snapshot = snapshotRefs(repo);
  const sealed = revParse(repo, "HEAD");

  // A hostile session: moves ANOTHER branch, creates a ref, checks out main
  // (so a naive `reset --hard` would clobber main, not the PR branch), and
  // dirties the tree.
  writeFileSync(join(repo, "src.ts"), "export const evil = true;\n");
  execSync("git -c user.email=t@t -c user.name=t commit -qam evil", { cwd: repo });
  execSync("git branch -f other-pr HEAD", { cwd: repo });
  execSync("git checkout -q main", { cwd: repo });
  writeFileSync(join(repo, "stray.txt"), "dirt\n");

  restoreRefs(repo, snapshot, "dependabot/npm_and_yarn/x");
  assert.deepEqual(refDrift(repo, snapshot), []);
  assert.equal(revParse(repo, "HEAD"), sealed);
  assert.equal(
    execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim(),
    "dependabot/npm_and_yarn/x",
  );
  assert.equal(existsSync(join(repo, "stray.txt")), false);
});

test("restoreRefs recreates a deleted checkout branch before checking it out", () => {
  const repo = tempRepo();
  execSync("git checkout -qb dependabot/npm_and_yarn/x", { cwd: repo });
  const snapshot = snapshotRefs(repo);
  const sealed = revParse(repo, "HEAD");
  // The session deletes the PR branch out from under itself via a detour.
  execSync("git checkout -q --detach", { cwd: repo });
  execSync("git branch -D dependabot/npm_and_yarn/x", { cwd: repo });
  restoreRefs(repo, snapshot, "dependabot/npm_and_yarn/x");
  assert.deepEqual(refDrift(repo, snapshot), []);
  assert.equal(revParse(repo, "HEAD"), sealed);
});

test("snapshotWorktree/worktreeDrift detects verification side effects", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, "src.ts"), "export const fixed = true;\n");
  const beforeVerification = snapshotWorktree(repo);
  assert.deepEqual(worktreeDrift(repo, beforeVerification), []);

  // The fixer change already existed in the snapshot; changing it again and
  // adding a denied file models side effects from the final verification.
  writeFileSync(join(repo, "src.ts"), "export const verificationWroteThis = true;\n");
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/evil.yml"), "on: push\n");
  assert.deepEqual(worktreeDrift(repo, beforeVerification), [
    ".github/workflows/evil.yml",
    "src.ts",
  ]);
});

test("createRepairBundle round-trips the repair range into another repository", () => {
  // The bundle is how a repair commit crosses the analyze→publish job gap
  // (the jobs never share a runner). Its prerequisite pins it to the exact
  // updater tip, and a receiver that has that tip can fetch the range out.
  const src = tempRepo();
  const branch = currentBranch(src);
  const base = revParse(src, "HEAD");
  writeFileSync(join(src, "src.ts"), "export const repaired = 1;\n");
  const repair = commitAll(src, "fix: adapt code to dep update");
  assert.ok(repair);

  const workDir = mkdtempSync(join(tmpdir(), "depvisor-bundle-"));
  const bundle = join(workDir, "repair.bundle");
  createRepairBundle(src, bundle, base, branch);

  // A receiver holding the prerequisite (the updater tip) can verify + fetch.
  const recv = join(workDir, "recv");
  execSync(`git clone -q "${src}" "${recv}"`);
  execSync(`git -C "${recv}" reset -q --hard ${base}`);
  execSync(`git -C "${recv}" bundle verify "${bundle}"`, { stdio: "ignore" });
  execSync(`git -C "${recv}" fetch -q "${bundle}" refs/heads/${branch}:refs/depvisor/repair`);
  assert.equal(revParse(recv, "refs/depvisor/repair"), repair);
});
