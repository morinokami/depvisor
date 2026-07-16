import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialRecord, readRunRecord, statusFails } from "../src/core/status.ts";

test("classifies published, reviewed, deferred and irrelevant PRs as green", () => {
  for (const status of [
    "reviewed",
    "repair-published",
    "deferred",
    "unsupported-pr",
    "stale-pr",
  ] as const) {
    assert.equal(statusFails(status), false, status);
  }
});

test("fails closed for incomplete and unsafe outcomes", () => {
  assert.equal(statusFails("in-progress"), true);
  assert.equal(statusFails("setup-failed"), true);
  assert.equal(statusFails("dependency-state-changed"), true);
  assert.equal(initialRecord("agent-failed", "failed").repaired, false);
});

test("rejects an injected status and drops malformed usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-v2-"));
  const file = join(dir, "status.json");
  writeFileSync(file, JSON.stringify({ version: 2, status: "reviewed\nforged" }));
  assert.equal(readRunRecord(file), null);

  writeFileSync(
    file,
    JSON.stringify({
      ...initialRecord("reviewed", "ok"),
      usage: { totalTokens: "many", costUsd: -1, model: "bad" },
    }),
  );
  assert.equal(readRunRecord(file)?.usage, null);
});
