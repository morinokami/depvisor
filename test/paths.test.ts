import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeRepoPath } from "../src/core/paths.ts";

test("accepts ordinary repository-relative paths", () => {
  for (const path of ["package.json", "src/index.ts", "a b/c-d_e.txt", "深い/パス.md"]) {
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
