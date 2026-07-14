import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  listRepoFiles,
  readRepoFile,
  replaceRepoText,
  searchRepo,
  writeRepoFile,
} from "../src/tools/repo-files.ts";

function fixture(): { repo: string; outside: string; dispose(): void } {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-tools-repo-"));
  const outside = mkdtempSync(join(tmpdir(), "depvisor-tools-outside-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(outside, "secret"), "do not read\n");
  symlinkSync(outside, join(repo, "escape"));
  return {
    repo,
    outside,
    dispose: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

test("repo tools expose bounded ordinary files", () => {
  const target = fixture();
  try {
    assert.match(readRepoFile(target.repo, "src/index.ts").content, /answer/);
    assert.deepEqual(listRepoFiles(target.repo).files, ["src/index.ts"]);
    assert.match(searchRepo(target.repo, "answer").output, /src\/index\.ts:1/);
    replaceRepoText(target.repo, "src/index.ts", "42", "43");
    assert.match(readRepoFile(target.repo, "src/index.ts").content, /43/);
    writeRepoFile(target.repo, "src/new.ts", "export {};\n");
    assert.match(readRepoFile(target.repo, "src/new.ts").content, /export/);
  } finally {
    target.dispose();
  }
});

test("repo tools reject traversal, .git, and symlink escapes", () => {
  const target = fixture();
  try {
    assert.throws(() => readRepoFile(target.repo, "../secret"), /escapes/);
    assert.throws(() => readRepoFile(target.repo, ".git/config"), /\.git/);
    assert.throws(() => readRepoFile(target.repo, "escape/secret"), /outside/);
    assert.throws(() => writeRepoFile(target.repo, "escape/new", "bad"), /outside/);
  } finally {
    target.dispose();
  }
});
