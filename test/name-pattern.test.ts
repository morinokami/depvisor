import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describePattern,
  expandPatterns,
  matchesPattern,
  parseNamePattern,
  patternsOverlap,
} from "../src/core/name-pattern.ts";

test("parseNamePattern accepts exact names, scoped and unscoped", () => {
  assert.deepEqual(parseNamePattern("lodash"), { name: "lodash" });
  assert.deepEqual(parseNamePattern("@types/node"), { name: "@types/node" });
});

test("parseNamePattern accepts trailing-'*' prefix globs", () => {
  assert.deepEqual(parseNamePattern("@types/*"), { namePrefix: "@types/" });
  assert.deepEqual(parseNamePattern("@acme/ui-*"), { namePrefix: "@acme/ui-" });
  assert.deepEqual(parseNamePattern("eslint-*"), { namePrefix: "eslint-" });
  // No dangling separator required: `eslint*` matches `eslint` itself too.
  assert.deepEqual(parseNamePattern("eslint*"), { namePrefix: "eslint" });
});

test("parseNamePattern fails closed on every other pattern shape", () => {
  for (const entry of [
    "*", // match-everything
    "@*", // partial scope
    "@acme*", // partial scope — would cross into @acme-tools/
    "*eslint", // leading *
    "foo*bar", // interior *
    "@acme/**", // double *
    "@acme/*@3", // glob + major (ignore's exact-name form only)
    "eslint-?", // ? is not supported
    "../etc/passwd",
    "@",
    "bad name",
  ]) {
    assert.equal(parseNamePattern(entry), null, `expected null for '${entry}'`);
  }
});

test("matchesPattern: exact equality vs string prefix", () => {
  assert.ok(matchesPattern("lodash", { name: "lodash" }));
  assert.ok(!matchesPattern("lodash-es", { name: "lodash" }));
  assert.ok(matchesPattern("@types/react", { namePrefix: "@types/" }));
  assert.ok(matchesPattern("eslint", { namePrefix: "eslint" }));
  assert.ok(!matchesPattern("@types-x/react", { namePrefix: "@types/" }));
});

test("describePattern round-trips the user's spelling", () => {
  assert.equal(describePattern({ name: "@types/node" }), "@types/node");
  assert.equal(describePattern({ namePrefix: "@types/" }), "@types/*");
});

test("patternsOverlap: equality, prefix containment, and stem-prefix pairs", () => {
  // exact / exact
  assert.ok(patternsOverlap({ name: "react" }, { name: "react" }));
  assert.ok(!patternsOverlap({ name: "react" }, { name: "react-dom" }));
  // exact / prefix, both directions
  assert.ok(patternsOverlap({ name: "@types/react" }, { namePrefix: "@types/" }));
  assert.ok(patternsOverlap({ namePrefix: "@types/" }, { name: "@types/react" }));
  assert.ok(!patternsOverlap({ name: "react" }, { namePrefix: "@types/" }));
  // prefix / prefix: overlap iff one stem is a prefix of the other
  assert.ok(patternsOverlap({ namePrefix: "@acme/" }, { namePrefix: "@acme/ui-" }));
  assert.ok(patternsOverlap({ namePrefix: "@acme/ui-" }, { namePrefix: "@acme/" }));
  assert.ok(!patternsOverlap({ namePrefix: "@acme/ui-" }, { namePrefix: "@acme/api-" }));
});

test("expandPatterns keeps only the names some pattern matches", () => {
  const expanded = expandPatterns(
    [{ namePrefix: "@acme/" }, { name: "left-pad" }],
    ["@acme/tokens", "@acme/eslint-config", "left-pad", "lodash"],
  );
  assert.deepEqual([...expanded].toSorted(), ["@acme/eslint-config", "@acme/tokens", "left-pad"]);
  // Zero matches is normal — the documented misspelled-name behavior.
  assert.equal(expandPatterns([{ namePrefix: "@nope/" }], ["lodash"]).size, 0);
});
