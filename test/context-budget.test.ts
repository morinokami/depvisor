import { test } from "node:test";
import assert from "node:assert/strict";
import { takeText } from "../src/core/context-budget.ts";

test("shares one total character budget across patches", () => {
  const budget = { remaining: 7 };
  assert.equal(takeText("abcdef", 4, budget), "abcd");
  assert.equal(takeText("uvwxyz", 10, budget), "uvw");
  assert.equal(takeText("more", 10, budget), "");
  assert.equal(budget.remaining, 0);
});
