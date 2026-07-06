import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitRunStatus,
  readRunStatus,
  renderStepSummary,
  runFailsJob,
  statusFailsJob,
  statusPath,
  toRunOutput,
  updateGroupStatus,
  type GroupResult,
  type RunStatus,
} from "../src/core/status.ts";

const group = (patch: Partial<GroupResult> = {}): GroupResult => ({
  status: "pr-prepared",
  branch: "depvisor/dev-minor",
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

const run = (patch: Partial<RunStatus> = {}): RunStatus => ({
  status: "completed",
  base: "main",
  summary: "Prepared 1 PR(s) from 1 group(s).",
  groups: [group()],
  ...patch,
});

test("status failure policy keeps benign outcomes green and fail-closed stops red", () => {
  for (const status of [
    "completed",
    "no-updates",
    "pr-prepared",
    "pr-up-to-date",
    "deferred",
    "open-pr-blocked",
    "held-back-by-limit",
  ]) {
    assert.equal(statusFailsJob(status), false);
  }
  for (const status of [
    "in-progress",
    "baseline-red",
    "reset-failed",
    "bad-max-prs",
    "reinstall-unavailable",
    "branch-collision",
    "verification-failed",
    "scope-violation",
    "unexpected-commits",
    "no-structured-result",
    "missing-base",
    "no-changes",
    "open-pr-failed",
  ]) {
    assert.equal(statusFailsJob(status), true);
  }
});

test("toRunOutput projects the workflow output, dropping packages and prUrl", () => {
  const output = toRunOutput(run({ groups: [group({ prUrl: "https://github.com/o/r/pull/1" })] }));
  assert.equal(output.status, "completed");
  assert.equal(output.base, "main");
  assert.equal(output.groups.length, 1);
  const g = output.groups[0] as Record<string, unknown>;
  assert.equal(g.status, "pr-prepared");
  assert.equal(g.branch, "depvisor/dev-minor");
  assert.deepEqual(g.verification, [{ name: "pnpm run test", ok: true, code: 0 }]);
  assert.ok(!("packages" in g), "packages must be stripped from the workflow output");
  assert.ok(!("prUrl" in g), "prUrl must be stripped from the workflow output");
});

test("runFailsJob fails a completed run when any group failed", () => {
  assert.equal(runFailsJob(run()), false);
  assert.equal(
    runFailsJob(run({ groups: [group(), group({ status: "verification-failed" })] })),
    true,
    "a completed run with a failed group must fail the job (silent no-PR is surfaced)",
  );
  assert.equal(
    runFailsJob(run({ status: "reset-failed", groups: [group()] })),
    true,
    "a run-level failure fails the job even when its groups succeeded",
  );
  assert.equal(
    runFailsJob(run({ groups: [group({ status: "held-back-by-limit", prUrl: null })] })),
    false,
    "held-back-by-limit is a benign outcome",
  );
});

test("run status is emitted, read, and patched per group by branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = emitRunStatus(
    dir,
    run({
      groups: [
        group({ branch: "depvisor/dev-minor" }),
        group({ branch: "depvisor/prod-semver", group: "prod/semver" }),
      ],
    }),
  );
  assert.equal(file, statusPath(dir));
  assert.equal(readRunStatus(file)?.groups.length, 2);

  const next = updateGroupStatus(file, "depvisor/prod-semver", {
    prUrl: "https://github.com/o/r/pull/2",
  });
  // Only the matching group is patched.
  assert.equal(
    next?.groups.find((g) => g.branch === "depvisor/prod-semver")?.prUrl,
    "https://github.com/o/r/pull/2",
  );
  assert.equal(next?.groups.find((g) => g.branch === "depvisor/dev-minor")?.prUrl, null);
  assert.equal(
    readRunStatus(file)?.groups.find((g) => g.branch === "depvisor/prod-semver")?.prUrl,
    "https://github.com/o/r/pull/2",
  );
});

test("updateGroupStatus can flip a single group to a failed open-pr outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = emitRunStatus(dir, run());
  updateGroupStatus(file, "depvisor/dev-minor", {
    status: "open-pr-failed",
    summary: "PR creation failed: boom",
  });
  const patched = readRunStatus(file);
  assert.equal(patched?.status, "completed");
  assert.equal(runFailsJob(patched as RunStatus), true);
});

test("testChanges survives the open-pr read/rewrite round-trip (parseGroup preserves it)", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = emitRunStatus(
    dir,
    run({
      groups: [group({ testChanges: [{ path: "test/a.test.ts", added: 2, removed: 9 }] })],
    }),
  );
  // open-pr patches the PR URL back in via read → rewrite; testChanges must not
  // be dropped by parseGroup when that happens.
  updateGroupStatus(file, "depvisor/dev-minor", { prUrl: "https://github.com/o/r/pull/9" });
  const g = readRunStatus(file)?.groups[0];
  assert.equal(g?.prUrl, "https://github.com/o/r/pull/9");
  assert.deepEqual(g?.testChanges, [{ path: "test/a.test.ts", added: 2, removed: 9 }]);
});

test("step summary surfaces a test-changes warning, validating and counting unsafe paths", () => {
  const summary = renderStepSummary(
    run({
      groups: [
        group({
          testChanges: [
            { path: "test/a.test.ts", added: 2, removed: 9 },
            { path: "snap.bin", added: null, removed: null },
            { path: "test/ev`il.test.ts", added: 1, removed: 0 },
          ],
        }),
      ],
    }),
  );
  assert.ok(summary.includes("#### ⚠️ Tests modified by the agent (3)"));
  assert.ok(summary.includes("| `test/a.test.ts` | +2 / -9 |"));
  assert.ok(summary.includes("| `snap.bin` | binary |"));
  // The backtick-bearing path is dropped from the list but still counted.
  assert.ok(!summary.includes("ev`il"));
  assert.ok(summary.includes("1 file(s) with unsafe names omitted"));
});

test("step summary renders run header, per-group sections, and sanitizes agent text", () => {
  const summary = renderStepSummary(
    run({
      groups: [
        group(),
        group({ status: "held-back-by-limit", branch: "depvisor/types", group: "types" }),
      ],
    }),
  );
  assert.ok(summary.includes("| Status | `completed` |"));
  assert.ok(summary.includes("| Groups | 2 |"));
  assert.ok(summary.includes("Group `dev-minor` — `pr-prepared`"));
  assert.ok(summary.includes("Group `types` — `held-back-by-limit`"));
  assert.ok(summary.includes("| knip | 6.23.0 | 6.24.0 | dev | minor |"));
  assert.ok(summary.includes("| pass | pnpm run test | 0 |"));
  assert.ok(!summary.includes("<!-- hidden -->"));
  assert.ok(!summary.includes("@octocat"));
  assert.ok(!summary.includes("\n::error::"));
});
