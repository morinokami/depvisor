import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSuggestFeatures } from "../src/core/suggest-features.ts";

test("parseSuggestFeatures treats empty/whitespace and 'false' as off", () => {
  for (const raw of ["", "   ", "\n", "false", "  false  "]) {
    assert.equal(parseSuggestFeatures(raw), false, `expected off for '${raw}'`);
  }
});

test("parseSuggestFeatures turns on for 'true' (trimmed)", () => {
  assert.equal(parseSuggestFeatures("true"), true);
  assert.equal(parseSuggestFeatures("  true  "), true);
});

test("parseSuggestFeatures fails closed on anything else", () => {
  // Case matters (config knobs are exact), and non-boolean junk is a typo the
  // run should surface as bad-suggest-features, not silently treat as off.
  for (const raw of ["TRUE", "False", "1", "0", "yes", "on", "enable", "tru", "true false"]) {
    assert.equal(parseSuggestFeatures(raw), null, `expected null for '${raw}'`);
  }
});
