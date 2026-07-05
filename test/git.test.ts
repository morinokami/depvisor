import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedPaths,
  commitPaths,
  commitAll,
  discardWorkPast,
  isRepoRoot,
  refExists,
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
