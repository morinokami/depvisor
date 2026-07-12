import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitRunStatus,
  readRunStatus,
  recordGroupOutcome,
  renderStepSummary,
  runFailsJob,
  runLogLine,
  statusFailsJob,
  statusPath,
  sumGroupUsage,
  toActionOutputs,
  toRunOutput,
  type GroupResult,
  type GroupUsage,
  type RunStatus,
} from "../src/core/status.ts";

const group = (patch: Partial<GroupResult> = {}): GroupResult => ({
  status: "pr-prepared",
  branch: "depvisor/dev-knip",
  group: "dev/knip",
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

const usage = (patch: Partial<GroupUsage> = {}): GroupUsage => ({
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
    "bad-open-pull-requests-limit",
    "reinstall-unavailable",
    "branch-collision",
    "verification-failed",
    "scope-violation",
    "unexpected-commits",
    "no-structured-result",
    "missing-base-branch",
    "no-changes",
    "open-pr-failed",
    "bump-failed",
  ]) {
    assert.equal(statusFailsJob(status), true);
  }
});

test("toRunOutput projects the workflow output, dropping packages, prUrl, and usage", () => {
  const output = toRunOutput(
    run({ groups: [group({ prUrl: "https://github.com/o/r/pull/1", usage: [usage()] })] }),
  );
  assert.equal(output.status, "completed");
  assert.equal(output.base, "main");
  assert.equal(output.groups.length, 1);
  const g = output.groups[0] as Record<string, unknown>;
  assert.equal(g.status, "pr-prepared");
  assert.equal(g.branch, "depvisor/dev-knip");
  assert.deepEqual(g.verification, [{ name: "pnpm run test", ok: true, code: 0 }]);
  assert.ok(!("packages" in g), "packages must be stripped from the workflow output");
  assert.ok(!("prUrl" in g), "prUrl must be stripped from the workflow output");
  assert.ok(!("usage" in g), "usage is record-only and must not appear in the workflow output");
});

test("toActionOutputs projects status, failed, prepared_count, and gated pr_urls", () => {
  const outputs = toActionOutputs(
    run({
      groups: [
        group({ prUrl: "https://github.com/o/r/pull/1" }),
        group({
          branch: "depvisor/prod-semver",
          group: "prod/semver",
          prUrl: "https://github.com/o/r/pull/2",
        }),
        group({ status: "held-back-by-limit", branch: "depvisor/dev-vitest", group: "dev/vitest" }),
      ],
    }),
  );
  assert.deepEqual(outputs, {
    status: "completed",
    failed: "false",
    prepared_count: "2",
    pr_urls: "https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2",
  });
});

test("toActionOutputs fails closed on off-vocabulary statuses and unsafe URLs", () => {
  const outputs = toActionOutputs(
    run({
      status: "Weird::status",
      groups: [group({ prUrl: "https://github.com/o/r/pull/1?x=`whoami`" })],
    }),
  );
  assert.equal(outputs.status, "", "an off-vocabulary status is dropped, not escaped");
  assert.equal(outputs.failed, "true", "failed derives from the raw status, not the gated one");
  assert.equal(outputs.pr_urls, "", "a URL outside the strict charset is dropped");
  assert.equal(outputs.prepared_count, "1");
});

test("toActionOutputs reports a missing status file (crash before reporting) as failed", () => {
  assert.deepEqual(toActionOutputs(null), {
    status: "",
    failed: "true",
    prepared_count: "0",
    pr_urls: "",
  });
});

test("toActionOutputs counts only pr-prepared groups; a red group flips failed", () => {
  const outputs = toActionOutputs(
    run({ groups: [group(), group({ status: "verification-failed", branch: "depvisor/x" })] }),
  );
  assert.equal(outputs.prepared_count, "1");
  assert.equal(outputs.failed, "true", "a completed run with a failed group is still a failure");
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
        group({ branch: "depvisor/dev-knip" }),
        group({ branch: "depvisor/prod-semver", group: "prod/semver" }),
      ],
    }),
  );
  assert.equal(file, statusPath(dir));
  assert.equal(readRunStatus(file)?.groups.length, 2);

  const next = recordGroupOutcome(file, "depvisor/prod-semver", {
    prUrl: "https://github.com/o/r/pull/2",
  });
  // Only the matching group is patched; nothing is appended.
  assert.equal(next?.groups.length, 2);
  assert.equal(
    next?.groups.find((g) => g.branch === "depvisor/prod-semver")?.prUrl,
    "https://github.com/o/r/pull/2",
  );
  assert.equal(next?.groups.find((g) => g.branch === "depvisor/dev-knip")?.prUrl, null);
  assert.equal(
    readRunStatus(file)?.groups.find((g) => g.branch === "depvisor/prod-semver")?.prUrl,
    "https://github.com/o/r/pull/2",
  );
});

test("recordGroupOutcome can flip a single group to a failed open-pr outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = emitRunStatus(dir, run());
  recordGroupOutcome(file, "depvisor/dev-knip", {
    status: "open-pr-failed",
    summary: "PR creation failed: boom",
  });
  const patched = readRunStatus(file);
  assert.equal(patched?.status, "completed");
  assert.equal(runFailsJob(patched), true);
});

test("recordGroupOutcome appends a synthetic entry for an unreadable payload (null branch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = emitRunStatus(dir, run());
  // The open-pr step cannot know the branch of a payload it failed to parse;
  // the appended open-pr-failed entry is what keeps the report step's outputs
  // consistent with the job the non-zero exit is about to fail.
  recordGroupOutcome(file, null, {
    status: "open-pr-failed",
    summary: "Unreadable PR payload 01-x.json: boom",
  });
  const next = readRunStatus(file);
  assert.equal(next?.groups.length, 2);
  const synthetic = next?.groups[1];
  assert.equal(synthetic?.status, "open-pr-failed");
  assert.equal(synthetic?.branch, null);
  assert.equal(runFailsJob(next), true);
  const outputs = toActionOutputs(next);
  assert.equal(outputs.failed, "true", "outputs must agree with the red job (review finding 1)");
});

test("recordGroupOutcome appends via fallback when a patched branch matches no entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = emitRunStatus(dir, run());
  // The opened-PR path patches only prUrl; a branch with no status entry must
  // not lose the URL (or, worse, silently no-op), so the fallback supplies the
  // appended entry's identity. The PR genuinely exists, so it stays green.
  const next = recordGroupOutcome(
    file,
    "depvisor/ghost",
    { prUrl: "https://github.com/o/r/pull/9" },
    { status: "pr-prepared", summary: "PR opened for a branch with no status entry." },
  );
  assert.equal(next?.groups.length, 2);
  const appended = next?.groups[1];
  assert.equal(appended?.status, "pr-prepared");
  assert.equal(appended?.branch, "depvisor/ghost");
  assert.equal(appended?.prUrl, "https://github.com/o/r/pull/9");
  assert.equal(runFailsJob(next), false);
  assert.equal(toActionOutputs(next).prepared_count, "2");
  assert.ok(toActionOutputs(next).pr_urls.includes("https://github.com/o/r/pull/9"));
});

test("readRunStatus and recordGroupOutcome fail toward null on a corrupt status file", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = statusPath(dir);
  writeFileSync(file, '{"status": "completed", "gro');
  // A truncated write must not crash the reporter (review finding 2) nor
  // open-pr's per-payload loop — both fail toward null, the same direction as
  // a missing file, and toActionOutputs(null) reports failed=true.
  assert.equal(readRunStatus(file), null);
  assert.equal(recordGroupOutcome(file, "depvisor/dev-knip", { prUrl: "x" }), null);
  assert.equal(toActionOutputs(readRunStatus(file)).failed, "true");
});

test("readRunStatus reads a non-object JSON root as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = statusPath(dir);
  for (const root of ["null", "42", '"completed"']) {
    writeFileSync(file, root);
    assert.equal(readRunStatus(file), null, `root ${root} must read as no status`);
  }
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
  recordGroupOutcome(file, "depvisor/dev-knip", { prUrl: "https://github.com/o/r/pull/9" });
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
  assert.ok(summary.includes("#### ⚠️ Tests modified in this update (3)"));
  assert.ok(summary.includes("| `test/a.test.ts` | +2 / -9 |"));
  assert.ok(summary.includes("| `snap.bin` | binary |"));
  // The backtick-bearing path is dropped from the list but still counted.
  assert.ok(!summary.includes("ev`il"));
  assert.ok(summary.includes("1 file(s) with unsafe names omitted"));
});

test("sumGroupUsage sums agent-run groups, dedupes models, and is null when none ran", () => {
  // Groups that never ran the agent carry no usage → nothing to sum.
  assert.equal(sumGroupUsage([group(), group({ status: "held-back-by-limit" })]), null);
  // An empty usage array counts as "no agent ran".
  assert.equal(sumGroupUsage([group({ usage: [] })]), null);

  const total = sumGroupUsage([
    group({ usage: [usage()] }),
    group({
      usage: [usage({ input: 500, output: 100, cacheRead: 0, totalTokens: 600, costUsd: 0.005 })],
    }),
    // A held-back group ran no agent, so it contributes nothing to the totals.
    group({ status: "held-back-by-limit" }),
  ]);
  assert.ok(total);
  assert.equal(total.groupCount, 2);
  assert.equal(total.input, 1500);
  assert.equal(total.output, 300);
  assert.equal(total.totalTokens, 1860);
  assert.ok(Math.abs(total.costUsd - 0.0173) < 1e-9);
  // Same model across both groups collapses to one entry.
  assert.deepEqual(total.models, ["anthropic/claude-opus-4-8"]);
});

test("sumGroupUsage sums across both operations in a two-operation group", () => {
  // A group that ran fixer AND digest carries two entries; both are summed, but
  // the group still counts once toward groupCount.
  const total = sumGroupUsage([
    group({
      usage: [
        usage({ role: "fixer", totalTokens: 1260 }),
        usage({
          role: "digest",
          input: 500,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 600,
          costUsd: 0.005,
        }),
      ],
    }),
  ]);
  assert.equal(total?.groupCount, 1, "one group, even though two operations ran");
  assert.equal(total?.totalTokens, 1860);
  assert.equal(total?.input, 1500);
});

test("sumGroupUsage keeps distinct models", () => {
  const total = sumGroupUsage([
    group({ usage: [usage({ model: "anthropic/claude-opus-4-8" })] }),
    group({ usage: [usage({ model: "openai/gpt-5" })] }),
  ]);
  assert.deepEqual(total?.models, ["anthropic/claude-opus-4-8", "openai/gpt-5"]);
});

test("usage survives the open-pr read/rewrite round-trip (parseGroup preserves the list)", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const usages = [usage({ role: "fixer" }), usage({ role: "digest", totalTokens: 600 })];
  const file = emitRunStatus(dir, run({ groups: [group({ usage: usages })] }));
  recordGroupOutcome(file, "depvisor/dev-knip", { prUrl: "https://github.com/o/r/pull/7" });
  const g = readRunStatus(file)?.groups[0];
  assert.equal(g?.prUrl, "https://github.com/o/r/pull/7");
  assert.deepEqual(g?.usage, usages);
});

test("parseGroup drops a usage entry with no recognized role (untrusted read-back)", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-status-"));
  const file = statusPath(dir);
  // A hand-edited or truncated status file whose usage entry lacks a valid role
  // must not crash the report; the illegible entry is dropped, the valid one kept.
  writeFileSync(
    file,
    JSON.stringify({
      status: "completed",
      base: "main",
      summary: "s",
      groups: [
        {
          status: "pr-prepared",
          branch: "b",
          group: "g",
          summary: "s",
          packages: [],
          verification: [],
          prUrl: null,
          usage: [{ totalTokens: 5 }, { role: "digest", totalTokens: 600, model: "m" }],
        },
      ],
    }),
  );
  const g = readRunStatus(file)?.groups[0];
  assert.equal(g?.usage?.length, 1);
  assert.equal(g?.usage?.[0]?.role, "digest");
});

test("step summary renders run-total and per-group LLM usage rows", () => {
  const summary = renderStepSummary(run({ groups: [group({ usage: [usage()] })] }));
  // Both the run header and the group table carry a usage row.
  assert.equal(summary.split("| LLM usage |").length - 1, 2);
  // The breakdown names every additive bucket (in + out + cache read + cache
  // write = 1,000 + 200 + 50 + 10 = 1,260), so it sums to the displayed total —
  // cache write is billed and must not be silently dropped.
  assert.ok(summary.includes("1,260 tokens (in 1,000 · out 200 · cache read 50 · cache write 10)"));
  assert.ok(summary.includes("est. ~$0.0123"));
  assert.ok(summary.includes("`anthropic/claude-opus-4-8`"));
});

test("step summary shows the group total plus a per-role breakdown", () => {
  const summary = renderStepSummary(
    run({
      groups: [
        group({
          usage: [
            usage({ role: "fixer", totalTokens: 12345 }),
            usage({
              role: "digest",
              input: 2000,
              output: 111,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2111,
              costUsd: 0.004,
            }),
          ],
        }),
      ],
    }),
  );
  // Group total sums both operations …
  assert.ok(summary.includes("14,456 tokens"), "group total sums fixer + digest tokens");
  // … and the compact per-role breakdown shows where they went.
  assert.ok(summary.includes("fixer 12,345 + digest 2,111"));
});

test("step summary omits the usage row when no group ran the agent", () => {
  const summary = renderStepSummary(run({ groups: [group({ status: "held-back-by-limit" })] }));
  assert.ok(!summary.includes("| LLM usage |"), "no agent ran, so no usage row is rendered");
});

test("runLogLine reports summed tokens and estimated cost", () => {
  const line = runLogLine(run({ groups: [group({ usage: [usage()] })] }));
  assert.ok(line.includes("tokens=1260"));
  assert.ok(line.includes("cost=~$0.0123"));
});

test("step summary renders run header, per-group sections, and sanitizes agent text", () => {
  const summary = renderStepSummary(
    run({
      groups: [
        group(),
        group({ status: "held-back-by-limit", branch: "depvisor/dev-vitest", group: "dev/vitest" }),
      ],
    }),
  );
  assert.ok(summary.includes("| Status | `completed` |"));
  assert.ok(summary.includes("| Groups | 2 |"));
  assert.ok(summary.includes("Group `dev/knip` — `pr-prepared`"));
  assert.ok(summary.includes("Group `dev/vitest` — `held-back-by-limit`"));
  assert.ok(summary.includes("| knip | 6.23.0 | 6.24.0 | dev | minor |"));
  assert.ok(summary.includes("| pass | pnpm run test | 0 |"));
  assert.ok(!summary.includes("<!-- hidden -->"));
  assert.ok(!summary.includes("@octocat"));
  assert.ok(!summary.includes("\n::error::"));
});
