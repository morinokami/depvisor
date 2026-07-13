import assert from "node:assert/strict";
import { test } from "node:test";
import { pollUnknownMergeability } from "../src/core/open-pr-poll.ts";

test("polling is limited to UNKNOWN depvisor PRs and normalizes REST results", async () => {
  let active = 0;
  let peak = 0;
  const seen: number[] = [];
  const output = await pollUnknownMergeability(
    [
      { number: 1, headRefName: "depvisor/a", mergeable: "UNKNOWN" },
      { number: 2, headRefName: "depvisor/b", mergeStateStatus: "UNKNOWN" },
      { number: 3, headRefName: "feature/c", mergeable: "UNKNOWN" },
      { number: 4, headRefName: "depvisor/d", mergeable: "MERGEABLE" },
      {
        number: 5,
        headRefName: "depvisor/e",
        mergeable: "UNKNOWN",
        mergeStateStatus: "DIRTY",
      },
    ],
    async (number) => {
      active += 1;
      peak = Math.max(peak, active);
      seen.push(number);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { mergeable: number !== 1 };
    },
    { maxAttempts: 2, deadlineMs: 1_000, concurrency: 2, intervalMs: 0 },
  );
  assert.deepEqual(
    seen.toSorted((a, b) => a - b),
    [1, 2],
  );
  assert.ok(peak <= 2);
  assert.equal(output[0]?.mergeable, "CONFLICTING");
  assert.equal(output[1]?.mergeable, "MERGEABLE");
  assert.equal(output[2]?.mergeable, "UNKNOWN");
  assert.equal(
    output[4]?.mergeable,
    "UNKNOWN",
    "an explicit DIRTY conflict must not be polled away",
  );
});

test("poll failures and malformed details stay UNKNOWN within the attempt bound", async () => {
  const calls = new Map<number, number>();
  const output = await pollUnknownMergeability(
    [
      { number: 1, headRefName: "depvisor/a", mergeable: "UNKNOWN" },
      { number: 2, headRefName: "depvisor/b", mergeable: "UNKNOWN" },
    ],
    async (number) => {
      calls.set(number, (calls.get(number) ?? 0) + 1);
      if (number === 1) throw new Error("temporary API failure");
      return { unexpected: true };
    },
    { maxAttempts: 3, deadlineMs: 1_000, concurrency: 1, intervalMs: 0 },
  );
  assert.equal(calls.get(1), 3);
  assert.equal(calls.get(2), 3);
  assert.deepEqual(
    output.map((entry) => entry.mergeable),
    ["UNKNOWN", "UNKNOWN"],
  );
});

test("an exhausted global deadline starts no poll work", async () => {
  let calls = 0;
  const output = await pollUnknownMergeability(
    [{ number: 1, headRefName: "depvisor/a", mergeable: "UNKNOWN" }],
    async () => {
      calls += 1;
      return { mergeable: false };
    },
    { maxAttempts: 10, deadlineMs: 0, concurrency: 4, intervalMs: 0 },
  );
  assert.equal(calls, 0);
  assert.equal(output[0]?.mergeable, "UNKNOWN");
});
