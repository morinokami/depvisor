import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTriple, parseVersionCore } from "../src/core/version-core.ts";

test("parseVersionCore reads the x.y.z core wherever it sits in the string", () => {
  assert.deepEqual(parseVersionCore("1.2.3"), [1, 2, 3]);
  // Loose on purpose: prerelease/tagged strings still classify by their core.
  assert.deepEqual(parseVersionCore("2.0.0-rc.1"), [2, 0, 0]);
  assert.deepEqual(parseVersionCore("v11.0.0"), [11, 0, 0]);
});

test("parseVersionCore returns null when no core is present", () => {
  assert.equal(parseVersionCore(""), null);
  assert.equal(parseVersionCore("MISSING"), null);
  assert.equal(parseVersionCore("1.2"), null);
});

test("compareTriple orders by major, then minor, then patch", () => {
  assert.ok(compareTriple([2, 0, 0], [1, 9, 9]) > 0);
  assert.ok(compareTriple([1, 2, 0], [1, 10, 0]) < 0);
  assert.ok(compareTriple([1, 2, 3], [1, 2, 10]) < 0);
  assert.equal(compareTriple([1, 2, 3], [1, 2, 3]), 0);
});
