import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeRepoPath } from "../src/core/paths.ts";

test("accepts ordinary repository-relative paths", () => {
  for (const path of [
    "package.json",
    "src/index.ts",
    "a b/c-d_e.txt",
    "深い/パス.md",
    ".gitignore",
    ".github/workflows/ci.yml",
    "a/.gitmodules",
  ]) {
    assert.equal(isSafeRepoPath(path), true, path);
  }
});

test("rejects traversal, absolute, control-byte and separator tricks", () => {
  for (const path of [
    "",
    "/etc/passwd",
    "../outside",
    "a/../b",
    "a/..",
    ".",
    "a/./b",
    "a//b",
    "a\\b",
    "a\0b",
    "a\nb",
    "a\u007fb",
    "a\tb",
  ]) {
    assert.equal(isSafeRepoPath(path), false, JSON.stringify(path));
  }
});

test("rejects .git segments in any position and case", () => {
  for (const path of [".git", ".git/config", "a/.git/hooks/pre-push", "a/.GIT/config"]) {
    assert.equal(isSafeRepoPath(path), false, path);
  }
});
