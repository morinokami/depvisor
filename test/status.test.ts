import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitRunStatus,
  emptyRunStatus,
  type OpUsage,
  readRunStatus,
  renderStepSummary,
  runFailsJob,
  runLogLine,
  type RunStatus,
  statusFailsJob,
  statusPath,
  sumUsage,
  toActionOutputs,
  toRunOutput,
} from "../src/core/status.ts";
import type { DependencyChange } from "../src/core/types.ts";

const change = (): DependencyChange => ({
  name: "lru-cache",
  from: "7.18.3",
  to: "11.2.1",
  kind: "prod",
  updateType: "major",
  locations: [""],
});

const usage = (patch: Partial<OpUsage> = {}): OpUsage => ({
  role: "fixer",
  input: 1000,
  output: 200,
  cacheRead: 50,
  cacheWrite: 10,
  totalTokens: 1260,
  costUsd: 0.0123,
  model: "anthropic/claude-opus-4-8",
  ...patch,
});

const run = (patch: Partial<RunStatus> = {}): RunStatus => ({
  status: "report-prepared",
  baseRef: "main",
  headRef: "dependabot/npm_and_yarn/lru-cache-11.2.1",
  headSha: "a".repeat(40),
  prNumber: 12,
  summary: "Verification passes on this PR as-is.",
  changes: [change()],
  verification: [{ name: "test", ok: true, code: 0 }],
  repaired: false,
  ...patch,
});

const tempDir = (): string => mkdtempSync(join(tmpdir(), "depvisor-status-"));

test("emit/read round-trips a full status, record-only fields included", () => {
  const dir = tempDir();
  const original = run({
    testChanges: [{ path: "test/a.test.ts", added: 3, removed: 1 }],
    usage: [usage(), usage({ role: "digest", totalTokens: 500, input: 400, output: 100 })],
  });
  const file = emitRunStatus(dir, original);
  assert.equal(file, statusPath(dir));
  assert.deepEqual(readRunStatus(file), original);
});

test("a sparse status file reads back with safe defaults", () => {
  const dir = tempDir();
  writeFileSync(statusPath(dir), '{"status":"deferred"}');
  assert.deepEqual(readRunStatus(statusPath(dir)), {
    status: "deferred",
    baseRef: null,
    headRef: null,
    headSha: null,
    prNumber: null,
    summary: "",
    changes: [],
    verification: [],
    repaired: false,
  });
  // a non-string status falls back to the (red) "unknown" vocabulary word
  writeFileSync(statusPath(dir), '{"status":5}');
  assert.equal(readRunStatus(statusPath(dir))?.status, "unknown");
  assert.equal(statusFailsJob("unknown"), true);
});

test("missing or corrupt status files read as null, never throw", () => {
  const dir = tempDir();
  assert.equal(readRunStatus(join(dir, "absent.json")), null);
  for (const corrupt of ["{ truncated", "null", '"a string"', "42"]) {
    writeFileSync(statusPath(dir), corrupt);
    assert.equal(readRunStatus(statusPath(dir)), null, corrupt);
  }
});

test("illegible usage entries and empty record-only arrays are dropped on read", () => {
  const dir = tempDir();
  const file = statusPath(dir);
  writeFileSync(
    file,
    JSON.stringify({ ...run(), usage: [{ role: "evil", totalTokens: 5 }], testChanges: [] }),
  );
  // display-only data fails toward "render nothing": no usage, no testChanges
  assert.deepEqual(readRunStatus(file), run());
});

test("only the benign statuses stay green", () => {
  const green = ["report-prepared", "repair-prepared", "not-an-update-pr", "deferred"];
  for (const status of green) {
    assert.equal(statusFailsJob(status), false, status);
    const outputs = toActionOutputs(run({ status }));
    assert.equal(outputs.failed, "false", status);
    assert.equal(outputs.status, status);
  }
  // The publish job's outcomes are its own outputs, never analyze statuses —
  // an unexpected appearance here must read as red, not silently green.
  // Likewise the crash marker and "analysis ran but the PR is still red".
  for (const status of [
    "publish-blocked",
    "in-progress",
    "verification-failed",
    "repair-failed",
    "unknown",
  ]) {
    assert.equal(statusFailsJob(status), true, status);
    assert.equal(toActionOutputs(run({ status })).failed, "true", status);
  }
  assert.equal(runFailsJob(run()), false);
});

test("an off-vocabulary status is dropped from outputs but still fails", () => {
  const outputs = toActionOutputs(run({ status: "Weird_Status;$(id)" }));
  assert.equal(outputs.status, "");
  assert.equal(outputs.failed, "true");
});

test("action outputs sum usage and blank the estimate for unpriced models", () => {
  const two = toActionOutputs(
    run({
      usage: [
        usage({ totalTokens: 1000, costUsd: 0.01 }),
        usage({ role: "digest", totalTokens: 500, costUsd: 0.0025 }),
      ],
    }),
  );
  assert.equal(two.total_tokens, "1500");
  assert.equal(two.est_cost_usd, "0.012500");
  // Flue reports an unpriced model as cost 0; a token-bearing zero-cost entry
  // makes the WHOLE estimate unavailable rather than understating the total.
  const unpriced = toActionOutputs(
    run({
      usage: [
        usage({ totalTokens: 1000, costUsd: 0.01 }),
        usage({ role: "digest", totalTokens: 500, costUsd: 0 }),
      ],
    }),
  );
  assert.equal(unpriced.total_tokens, "1500");
  assert.equal(unpriced.est_cost_usd, "");
  // invalid token counts fail toward zero at the exit boundary
  const invalid = toActionOutputs(run({ usage: [usage({ totalTokens: -5 })] }));
  assert.deepEqual([invalid.total_tokens, invalid.est_cost_usd], ["0", ""]);
  const none = toActionOutputs(run());
  assert.deepEqual([none.total_tokens, none.est_cost_usd], ["0", "0.000000"]);
});

test("a never-written status file still yields failed=true outputs", () => {
  assert.deepEqual(toActionOutputs(null), {
    status: "",
    failed: "true",
    repaired: "false",
    total_tokens: "0",
    est_cost_usd: "",
  });
});

test("sumUsage totals the operations that ran and dedupes models", () => {
  assert.equal(sumUsage(undefined), null);
  assert.equal(sumUsage([]), null);
  // identical numbers so the float sum is an exact doubling
  assert.deepEqual(sumUsage([usage(), usage({ role: "digest" })]), {
    totalTokens: 2520,
    input: 2000,
    output: 400,
    cacheRead: 100,
    cacheWrite: 20,
    costUsd: 0.0246,
    models: ["anthropic/claude-opus-4-8"],
  });
});

test("runLogLine stays one line and defuses ::workflow-command forgery", () => {
  const line = runLogLine(
    run({
      repaired: true,
      usage: [usage()],
      summary: "::error::pwn\nsecond <!-- hidden --> line",
    }),
  );
  assert.ok(!line.includes("\n"));
  assert.ok(line.startsWith("status=report-prepared"));
  assert.ok(line.includes("head=dependabot/npm_and_yarn/lru-cache-11.2.1"));
  assert.ok(line.includes("base=main"));
  assert.ok(line.includes("pr=#12"));
  assert.ok(line.includes("repaired=true"));
  assert.ok(line.includes("tokens=1260 cost=~$0.0123"));
  assert.ok(line.includes(": :error::pwn second"));
  assert.ok(!line.includes("hidden"));
});

test("renderStepSummary renders the field table, changes, verification, and warnings", () => {
  const summary = renderStepSummary(
    run({
      testChanges: [{ path: "test/a.test.ts", added: 2, removed: 1 }],
      usage: [usage()],
    }),
  );
  assert.ok(summary.includes("## depvisor"));
  assert.ok(summary.includes("| Status | `report-prepared` |"));
  assert.ok(summary.includes("| PR | #12 |"));
  assert.ok(summary.includes("### Dependency changes"));
  assert.ok(summary.includes("| lru-cache | 7.18.3 | 11.2.1 | prod | major |"));
  assert.ok(summary.includes("### Verification"));
  assert.ok(summary.includes("| pass | test | 0 |"));
  assert.ok(summary.includes("Tests modified by the repair (1)"));
  assert.ok(summary.includes("| `test/a.test.ts` | +2 / -1 |"));
  assert.ok(summary.includes("LLM usage"));
  assert.ok(
    renderStepSummary(emptyRunStatus("in-progress", "")).includes("No summary was emitted."),
  );
});

test("toRunOutput strips the record-only fields", () => {
  const out = toRunOutput(
    run({
      testChanges: [{ path: "test/a.test.ts", added: 1, removed: 1 }],
      usage: [usage()],
    }),
  );
  // usage/testChanges (record-only) and changes are not part of the workflow view
  assert.deepEqual(out, {
    status: "report-prepared",
    baseRef: "main",
    headRef: "dependabot/npm_and_yarn/lru-cache-11.2.1",
    headSha: "a".repeat(40),
    prNumber: 12,
    summary: "Verification passes on this PR as-is.",
    repaired: false,
    verification: [{ name: "test", ok: true, code: 0 }],
  });
});

test("emptyRunStatus is a fresh shell with nothing resolved", () => {
  assert.deepEqual(emptyRunStatus("in-progress", "run started"), {
    status: "in-progress",
    baseRef: null,
    headRef: null,
    headSha: null,
    prNumber: null,
    summary: "run started",
    changes: [],
    verification: [],
    repaired: false,
  });
});
