import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGroup, countOpenDepvisorPrs, parseMaxOpenPrs } from "../src/core/budget.ts";

test("parseMaxOpenPrs defaults empty to 5 and accepts positive integers", () => {
  assert.equal(parseMaxOpenPrs(""), 5);
  assert.equal(parseMaxOpenPrs("   "), 5);
  assert.equal(parseMaxOpenPrs("1"), 1);
  assert.equal(parseMaxOpenPrs("5"), 5);
  assert.equal(parseMaxOpenPrs(" 3 "), 3);
});

test("parseMaxOpenPrs rejects non-positive-integer input (fail-fast)", () => {
  for (const raw of ["0", "-1", "1.5", "abc", "2x", "1e3", "  0 "]) {
    assert.equal(parseMaxOpenPrs(raw), null, `expected null for '${raw}'`);
  }
});

test("countOpenDepvisorPrs counts only depvisor-owned branches", () => {
  assert.equal(
    countOpenDepvisorPrs(["depvisor/dev-knip", "depvisor/prod-semver", "feature/x", "renovate/y"]),
    2,
  );
  assert.equal(countOpenDepvisorPrs([]), 0);
});

test("classifyGroup: an up-to-date open PR is skipped and never consumes a slot", () => {
  assert.equal(classifyGroup({ hasOpenPr: true, upToDate: true, newSlots: 0 }), "skip-up-to-date");
});

test("classifyGroup: a drifted open PR is refreshed regardless of remaining slots", () => {
  // Refresh happens even when the ceiling is full — a refresh does not open a
  // new PR, so it must not be blocked by the budget.
  assert.equal(classifyGroup({ hasOpenPr: true, upToDate: false, newSlots: 0 }), "refresh");
  assert.equal(classifyGroup({ hasOpenPr: true, upToDate: false, newSlots: 3 }), "refresh");
});

test("classifyGroup: a new group opens only while slots remain, else held back", () => {
  assert.equal(classifyGroup({ hasOpenPr: false, upToDate: false, newSlots: 2 }), "open-new");
  assert.equal(classifyGroup({ hasOpenPr: false, upToDate: false, newSlots: 0 }), "held-back");
});

test("budget scenario: ceiling reached by existing PRs opens no new PR", () => {
  // max_open_prs=2, two existing open depvisor PRs already at the ceiling.
  const maxOpenPrs = parseMaxOpenPrs("2") as number;
  const open = ["depvisor/major-chalk", "depvisor/major-lru-cache"];
  let newSlots = Math.max(0, maxOpenPrs - countOpenDepvisorPrs(open));
  assert.equal(newSlots, 0);

  // A brand-new group is held back; an existing (drifted) one still refreshes.
  assert.equal(classifyGroup({ hasOpenPr: false, upToDate: false, newSlots }), "held-back");
  assert.equal(classifyGroup({ hasOpenPr: true, upToDate: false, newSlots }), "refresh");
});

test("budget scenario: successful new PRs consume slots in order", () => {
  const maxOpenPrs = parseMaxOpenPrs("2") as number;
  let newSlots = Math.max(0, maxOpenPrs - countOpenDepvisorPrs([])); // 2
  const dispositions: string[] = [];
  // Three new groups, each succeeds → only the first two open, third held back.
  for (let i = 0; i < 3; i++) {
    const d = classifyGroup({ hasOpenPr: false, upToDate: false, newSlots });
    dispositions.push(d);
    if (d === "open-new") newSlots -= 1; // simulate a prepared PR consuming a slot
  }
  assert.deepEqual(dispositions, ["open-new", "open-new", "held-back"]);
});
