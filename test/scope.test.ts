import assert from "node:assert/strict";
import test from "node:test";
import { checkScopePaths, validatePatchEnvelope } from "../src/core/scope.ts";

test("candidate scope allows source and legitimate tests", () => {
  const result = checkScopePaths(
    ["src/cache.ts", "test/fixtures/cache.json", "pkg/cache_test.go"],
    ["package.json"],
  );
  assert.equal(result.ok, true);
});

test("candidate scope denies dependency state, execution surfaces, and docs", () => {
  const result = checkScopePaths(
    [
      "package.json",
      ".github/workflows/ci.yml",
      "go.mod",
      "README.md",
      "vendor/dependency.go",
      "scripts/check.sh",
      "vitest.config.ts",
    ],
    ["go.mod"],
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 7);
});

test("patch envelope is bounded and requires a git diff", () => {
  assert.equal(validatePatchEnvelope("").ok, false);
  assert.equal(validatePatchEnvelope("hello").ok, false);
  assert.equal(validatePatchEnvelope("diff --git a/a.ts b/a.ts\n").ok, true);
});
