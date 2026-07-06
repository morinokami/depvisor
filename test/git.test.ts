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

test("diffNumstat parses normal, binary, rename and awkward filenames from base..HEAD", () => {
  const repo = tempRepo();
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  const base = sh("git rev-parse --abbrev-ref HEAD").trim();
  // Seed a file to rename and a binary blob at the base.
  writeFileSync(join(repo, "to-rename.txt"), "old\nkeep\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm seed");

  sh("git checkout -q -b depvisor/prod-x");
  // Normal edit (2 added, 1 removed), a rename with an edit, a binary change, and
  // filenames git can legitimately produce that would break naive markdown parsing.
  writeFileSync(join(repo, "src.ts"), "export const a = 1;\nexport const b = 2;\n");
  sh("git mv to-rename.txt renamed.txt");
  writeFileSync(join(repo, "renamed.txt"), "old\nkeep\nappended\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  writeFileSync(join(repo, "a b.txt"), "x\n");
  writeFileSync(join(repo, "back`tick.txt"), "y\n");
  sh("git add -A && git -c user.email=t@t -c user.name=t commit -qm change");

  const byPath = new Map(diffNumstat(repo, base, "HEAD").map((e) => [e.path, e]));
  assert.deepEqual(byPath.get("src.ts"), { path: "src.ts", added: 2, removed: 1 });
  // Binary files report null counts (git prints "-").
  assert.deepEqual(byPath.get("blob.bin"), { path: "blob.bin", added: null, removed: null });
  // A rename keeps the destination path, never the source.
  assert.ok(byPath.has("renamed.txt"), "rename destination is present");
  assert.ok(!byPath.has("to-rename.txt"), "rename source is not double-counted");
  // -z keeps unquoted paths verbatim, including spaces and backticks.
  assert.deepEqual(byPath.get("a b.txt"), { path: "a b.txt", added: 1, removed: 0 });
  assert.deepEqual(byPath.get("back`tick.txt"), { path: "back`tick.txt", added: 1, removed: 0 });
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
