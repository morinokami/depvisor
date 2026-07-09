import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedPaths,
  commitPaths,
  commitAll,
  diffNumstat,
  discardWorkPast,
  isRepoRoot,
  manifestBumpPaths,
  manifestDiff,
  refExists,
  resetToBase,
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

test("changedPaths does not truncate the first entry (leading-space status)", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, "package-lock.json"), '{"changed":1}\n');
  writeFileSync(join(repo, "package.json"), '{"changed":1}\n');
  // package-lock.json sorts first; a trimmed porcelain parse used to return
  // 'ackage-lock.json' here and silently drop it from the bump commit.
  assert.deepEqual(changedPaths(repo), ["package-lock.json", "package.json"]);
});

test("changedPaths reports quoting-triggering paths verbatim and they stay committable", () => {
  const repo = tempRepo();
  // Non-ASCII and embedded-quote names make non-`-z` porcelain C-quote the path
  // (`"\346…"`); the escaped string no longer names the real file, so a bump
  // commit's `git add` pathspec failed and a scope read saw nothing on either
  // side. `-z` prints paths verbatim.
  mkdirSync(join(repo, "ワークスペース"));
  writeFileSync(join(repo, "ワークスペース/package.json"), '{"name":"ws"}\n');
  writeFileSync(join(repo, 'has"quote.txt'), "x\n");
  execSync("git add -A", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit -qm add", { cwd: repo });

  writeFileSync(join(repo, "ワークスペース/package.json"), '{"name":"ws","version":"2"}\n');
  writeFileSync(join(repo, 'has"quote.txt'), "y\n");
  assert.deepEqual(changedPaths(repo).sort(), ['has"quote.txt', "ワークスペース/package.json"]);

  // The mechanical bump path must reach the commit, not die on a pathspec.
  const bump = manifestBumpPaths(repo, ["package-lock.json"]);
  assert.deepEqual(bump, ["ワークスペース/package.json"]);
  const sha = commitPaths(repo, bump, "deps: bump");
  assert.ok(sha);
  assert.deepEqual(changedPaths(repo).sort(), ['has"quote.txt']);
});

test("changedPaths lists files under a new untracked directory individually, not collapsed", () => {
  const repo = tempRepo();
  // git collapses a brand-new untracked dir to `pkgs/` by default, which would
  // hide the package.json inside from the scope gate's basename check.
  mkdirSync(join(repo, "pkgs/evil"), { recursive: true });
  writeFileSync(join(repo, "pkgs/evil/package.json"), '{"name":"evil"}\n');
  writeFileSync(join(repo, "pkgs/evil/index.js"), "module.exports = 1;\n");
  assert.deepEqual(changedPaths(repo).sort(), ["pkgs/evil/index.js", "pkgs/evil/package.json"]);
});

test("changedPaths keeps only the destination of a staged rename (-z ORIG_PATH dropped)", () => {
  const repo = tempRepo();
  execSync("git mv src.ts renamed.ts", { cwd: repo });
  writeFileSync(join(repo, "package.json"), '{"changed":1}\n');
  assert.deepEqual(changedPaths(repo).sort(), ["package.json", "renamed.ts"]);
});

test("commitPaths/commitAll split manifests from code fixes", () => {
  const repo = tempRepo();
  writeFileSync(join(repo, "package.json"), '{"v":2}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"v":2}\n');
  writeFileSync(join(repo, "src.ts"), "export const fixed = true;\n");

  const bump = commitPaths(repo, ["package.json", "package-lock.json"], "deps: bump");
  assert.ok(bump);
  const bumpFiles = execSync("git show --name-only --format=", { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(bumpFiles.sort(), ["package-lock.json", "package.json"]);

  const fix = commitAll(repo, "fix: adapt");
  assert.ok(fix);
  const fixFiles = execSync("git show --name-only --format=", { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(fixFiles, ["src.ts"]);

  // Nothing left → both are null on a second call.
  assert.equal(commitPaths(repo, ["package.json"], "x"), null);
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

test("manifestBumpPaths selects every package.json and lockfile by basename (workspaces)", () => {
  const repo = tempRepo();
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  writeFileSync(join(repo, "packages/a/package.json"), "{}\n");
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm ws", { cwd: repo });

  // A monorepo bump touches the root manifest + lockfile AND a workspace manifest,
  // plus source the agent fixed.
  writeFileSync(join(repo, "package.json"), '{"v":2}\n');
  writeFileSync(join(repo, "package-lock.json"), '{"v":2}\n');
  writeFileSync(join(repo, "packages/a/package.json"), '{"v":2}\n');
  writeFileSync(join(repo, "src.ts"), "export const fixed = true;\n");

  // Nested workspace manifest is picked up; src.ts is not.
  assert.deepEqual(manifestBumpPaths(repo, ["package-lock.json", "npm-shrinkwrap.json"]).sort(), [
    "package-lock.json",
    "package.json",
    "packages/a/package.json",
  ]);

  const bump = commitPaths(
    repo,
    manifestBumpPaths(repo, ["package-lock.json", "npm-shrinkwrap.json"]),
    "deps: bump",
  );
  assert.ok(bump);
  const bumpFiles = execSync("git show --name-only --format=", { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(bumpFiles.sort(), [
    "package-lock.json",
    "package.json",
    "packages/a/package.json",
  ]);
  // The agent's code fix stays in the second commit.
  const fix = commitAll(repo, "fix: adapt");
  assert.ok(fix);
  const fixFiles = execSync("git show --name-only --format=", { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(fixFiles, ["src.ts"]);
});

test("manifestBumpPaths includes extra root manifests exactly, not by basename", () => {
  const repo = tempRepo();
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "catalog:\n  semver: ^7.3.0\n");
  writeFileSync(join(repo, "packages/a/pnpm-workspace.yaml"), "x: 1\n");
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -qm ws", { cwd: repo });

  // A catalog bump touches pnpm-workspace.yaml + lockfile, plus a source fix —
  // and a (meaningless-to-pnpm) nested same-named file the agent also touched.
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "catalog:\n  semver: ^7.7.3\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "v: 2\n");
  writeFileSync(join(repo, "packages/a/pnpm-workspace.yaml"), "x: 2\n");
  writeFileSync(join(repo, "src.ts"), "export const fixed = true;\n");

  assert.deepEqual(manifestBumpPaths(repo, ["pnpm-lock.yaml"], ["pnpm-workspace.yaml"]).sort(), [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]);
});

test("discardWorkPast drops commits, tracked edits, and untracked files", () => {
  const repo = tempRepo();
  const head = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();

  // A deferred agent attempt may leave all three kinds of leftovers behind.
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

test("resetToBase returns to base, discards work, and keeps ignored files + the branch ref", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  // Capture the init default branch name; it varies (main vs master) by git config.
  const base = sh("git rev-parse --abbrev-ref HEAD").trim();
  // node_modules is ignored; the reinstall (not resetToBase) is what restores it.
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm gitignore");

  // A previous group: commit on its own branch, then a dirty tree + untracked file.
  sh("git checkout -q -b depvisor/prod-x");
  writeFileSync(join(repo, "src.ts"), "export const changed = true;\n");
  sh("git -c user.email=t@t -c user.name=t commit -aqm 'group work'");
  writeFileSync(join(repo, "src.ts"), "export const uncommittedEdit = true;\n"); // dirty tracked
  writeFileSync(join(repo, "stray.ts"), "export {};\n"); // untracked
  mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules/pkg/index.js"), "module.exports = 1;\n"); // ignored

  resetToBase(repo, base);

  // Back on base, tree clean, untracked removed.
  assert.equal(sh("git rev-parse --abbrev-ref HEAD").trim(), base);
  assert.equal(sh("git status --porcelain").trim(), "");
  assert.ok(!existsSync(join(repo, "stray.ts")), "untracked files are removed");
  // Ignored files survive (the reinstall restores them, not the reset).
  assert.ok(existsSync(join(repo, "node_modules/pkg/index.js")), "ignored files are kept");
  // The group's branch ref still exists so open-pr can push it.
  assert.equal(refExists(repo, "depvisor/prod-x"), true);
});

test("diffNumstat parses normal, binary and awkward filenames, decomposing moves (--no-renames)", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const base = sh("git rev-parse --abbrev-ref HEAD").trim();
  // Seed a file to move and a binary blob at the base.
  writeFileSync(join(repo, "to-move.txt"), "old\nkeep\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm seed");

  sh("git checkout -q -b depvisor/prod-x");
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

  sh("git checkout -q -b depvisor/prod-x");
  mkdirSync(join(repo, "src"), { recursive: true });
  sh("git mv test/x.test.ts src/x.ts");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm 'move test out'");

  const paths = diffNumstat(repo, base, "HEAD")
    .map((e) => e.path)
    .sort();
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

  // A bump touches root + nested manifests, pnpm-workspace.yaml, the lockfile,
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

  const diff = manifestDiff(repo, "HEAD~1", "HEAD");
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
