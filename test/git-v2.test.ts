import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRepairChanges, headSha, isClean } from "../src/core/git.ts";

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
  const repair = captureRepairChanges(dir);
  assert.deepEqual(repair.paths, ["new/file.txt", "tracked.txt"]);
  assert.match(repair.patch, /-before/);
  assert.equal(Buffer.from(repair.newFiles[0]!.contentBase64, "base64").toString(), "created\n");
  assert.equal(headSha(dir), before);
});

test("rejects a repair that exceeds the publication file limit", () => {
  const dir = repo();
  mkdirSync(join(dir, "many"));
  for (let index = 0; index < 201; index += 1) {
    writeFileSync(join(dir, `many/${index}.txt`), `${index}\n`);
  }
  assert.throws(() => captureRepairChanges(dir), /publication limit/);
});
