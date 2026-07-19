import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFixChanges, headSha, isClean, treeBlobPaths } from "../src/core/git.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-git-v2-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

test("captures tracked edits and untracked files without making a commit", () => {
  const dir = repo();
  const before = headSha(dir);
  writeFileSync(join(dir, "tracked.txt"), "after\n");
  mkdirSync(join(dir, "new"));
  writeFileSync(join(dir, "new/file.txt"), "created\n");
  assert.equal(isClean(dir), false);
  const fix = captureFixChanges(dir);
  assert.deepEqual(fix.paths, ["new/file.txt", "tracked.txt"]);
  assert.match(fix.patch, /-before/);
  assert.equal(Buffer.from(fix.newFiles[0]!.contentBase64, "base64").toString(), "created\n");
  assert.equal(headSha(dir), before);
});

test("enumerates committed blob paths and fails soft on an unknown ref", () => {
  const dir = repo();
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested/inner.txt"), "inner\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "nested"], { cwd: dir });
  const paths = treeBlobPaths(dir, "HEAD");
  assert.equal(paths.has("tracked.txt"), true);
  assert.equal(paths.has("nested/inner.txt"), true);
  assert.equal(paths.has("nested"), false);
  assert.equal(treeBlobPaths(dir, "not-a-ref").size, 0);
});

test("rejects a fix that exceeds the publication file limit", () => {
  const dir = repo();
  mkdirSync(join(dir, "many"));
  for (let index = 0; index < 201; index += 1) {
    writeFileSync(join(dir, `many/${index}.txt`), `${index}\n`);
  }
  assert.throws(() => captureFixChanges(dir), /publication limit/);
});
