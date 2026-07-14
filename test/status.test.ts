import assert from "node:assert/strict";
import test from "node:test";
import { statusClass, statusFailsJob } from "../src/core/status.ts";

test("v2 terminal status classes are explicit", () => {
  assert.equal(statusClass("not-updater"), "neutral");
  assert.equal(statusClass("repair-applied"), "green");
  assert.equal(statusClass("scope-violation"), "red");
  assert.equal(statusFailsJob("bad-config"), true);
});
