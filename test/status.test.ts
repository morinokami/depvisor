import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitRunStatus,
  readRunStatus,
  renderStepSummary,
  statusFailsJob,
  statusPath,
  updateRunStatus,
  type RunStatus,
} from "../src/core/status.ts";

const baseStatus = (patch: Partial<RunStatus> = {}): RunStatus => ({
  status: "pr-prepared",
  branch: "depvisor/dev-minor",
  base: "main",
  group: "dev-minor",
  summary: "Updated knip. <!-- hidden --> @octocat\n::error:: nope",
  packages: [
    {
      name: "knip",
      current: "6.23.0",
      latest: "6.24.0",
      kind: "dev",
      updateType: "minor",
    },
  ],
  verification: [{ name: "pnpm run test", ok: true, code: 0 }],
  prUrl: null,
  ...patch,
});

test("status failure policy keeps no-op successes green and blocked outcomes red", () => {
  for (const status of ["pr-prepared", "pr-up-to-date", "no-updates", "deferred"]) {
    assert.equal(statusFailsJob(status), false);
  }
  for (const status of [
    "baseline-red",
    "verification-failed",
    "scope-violation",
    "missing-base",
    "no-changes",
  ]) {
    assert.equal(statusFailsJob(status), true);
  }
});

test("run status is emitted, read, and patched with the PR URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = emitRunStatus(dir, baseStatus());
  assert.equal(file, statusPath(dir));
  assert.equal(readRunStatus(file)?.status, "pr-prepared");

  const next = updateRunStatus(file, { prUrl: "https://github.com/o/r/pull/1" });
  assert.equal(next?.prUrl, "https://github.com/o/r/pull/1");
  assert.equal(readRunStatus(file)?.prUrl, "https://github.com/o/r/pull/1");
});

test("step summary sanitizes agent text and renders packages and verification", () => {
  const summary = renderStepSummary(baseStatus());
  assert.ok(summary.includes("| Status | `pr-prepared` |"));
  assert.ok(summary.includes("| knip | 6.23.0 | 6.24.0 | dev | minor |"));
  assert.ok(summary.includes("| pass | pnpm run test | 0 |"));
  assert.ok(!summary.includes("<!-- hidden -->"));
  assert.ok(!summary.includes("@octocat"));
  assert.ok(!summary.includes("\n::error::"));
});
