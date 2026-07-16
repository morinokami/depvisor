import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedUpdater } from "../src/core/run-context.ts";

test("supports Dependabot and common Renovate bot identities", () => {
  assert.equal(isSupportedUpdater("dependabot[bot]"), true);
  assert.equal(isSupportedUpdater("renovate[bot]"), true);
  assert.equal(isSupportedUpdater("renovate-bot"), true);
  assert.equal(isSupportedUpdater("acme-renovate[bot]"), true);
});

test("does not process ordinary contributor PRs", () => {
  assert.equal(isSupportedUpdater("octocat"), false);
  assert.equal(isSupportedUpdater("renovation-helper"), false);
});
