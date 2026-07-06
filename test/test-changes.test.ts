import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTestChanges, formatNumstatLines, isTestPath } from "../src/core/test-changes.ts";
import type { NumstatEntry } from "../src/core/git.ts";

test("isTestPath matches common test directories and file-name conventions", () => {
  for (const p of [
    "test/foo.ts",
    "tests/foo.ts",
    "src/__tests__/foo.ts",
    "src/__mocks__/fs.ts",
    "spec/foo.rb",
    "e2e/login.ts",
    "cypress/e2e/a.cy.ts",
    "playwright/a.spec.ts",
    "src/foo.test.ts",
    "src/foo.spec.jsx",
    "src/foo.test.mjs",
    "pkg/handler_test.ts",
  ]) {
    assert.equal(isTestPath(p), true, `${p} should classify as a test`);
  }
});

test("isTestPath does not fire on production paths that merely contain the substring", () => {
  for (const p of [
    "src/latest/index.ts", // 'latest' contains 'test' but not as a segment
    "src/contest/index.ts",
    "src/testable.ts", // no separator / extension convention
    "src/attestation.ts",
    "package.json",
    "src/index.ts",
    "src/spectrum.ts", // 'spec' substring, not a 'spec/' segment
  ]) {
    assert.equal(isTestPath(p), false, `${p} should not classify as a test`);
  }
});

test("classifyTestChanges keeps only test entries, preserving counts", () => {
  const entries: NumstatEntry[] = [
    { path: "src/index.ts", added: 3, removed: 1 },
    { path: "test/index.test.ts", added: 5, removed: 8 },
    { path: "package.json", added: 1, removed: 1 },
    { path: "snap.bin", added: null, removed: null }, // not a test, binary
  ];
  assert.deepEqual(classifyTestChanges(entries), [
    { path: "test/index.test.ts", added: 5, removed: 8 },
  ]);
});

test("formatNumstatLines renders deltas and marks binary files", () => {
  assert.equal(formatNumstatLines({ path: "a", added: 5, removed: 8 }), "+5 / -8");
  assert.equal(formatNumstatLines({ path: "a", added: 0, removed: 0 }), "+0 / -0");
  assert.equal(formatNumstatLines({ path: "a", added: null, removed: null }), "binary");
});
