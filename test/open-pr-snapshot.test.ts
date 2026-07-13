import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  mergeabilityOf,
  normalizeRestMergeable,
  parseOpenPrSnapshot,
  readOpenPrSnapshot,
} from "../src/core/open-pr-snapshot.ts";

test("mergeability normalization gives conflict the highest precedence", () => {
  assert.deepEqual(mergeabilityOf({ mergeable: "CONFLICTING" }), {
    conflicted: true,
    mergeabilityUnknown: false,
    mergeabilityObserved: true,
  });
  assert.equal(mergeabilityOf({ mergeStateStatus: "DIRTY" }).conflicted, true);
  assert.equal(
    mergeabilityOf({ mergeable: "CONFLICTING", mergeStateStatus: "UNKNOWN" }).conflicted,
    true,
  );
  assert.deepEqual(mergeabilityOf({ mergeable: "MERGEABLE", mergeStateStatus: "UNKNOWN" }), {
    conflicted: false,
    mergeabilityUnknown: false,
    mergeabilityObserved: true,
  });
});

test("explicit UNKNOWN is distinct from absent and future enum values", () => {
  assert.deepEqual(mergeabilityOf({ mergeable: "UNKNOWN" }), {
    conflicted: false,
    mergeabilityUnknown: true,
    mergeabilityObserved: true,
  });
  assert.deepEqual(mergeabilityOf({ mergeable: "FUTURE", mergeStateStatus: "NEW_STATE" }), {
    conflicted: false,
    mergeabilityUnknown: false,
    mergeabilityObserved: false,
  });
  assert.deepEqual(mergeabilityOf({}), {
    conflicted: false,
    mergeabilityUnknown: false,
    mergeabilityObserved: false,
  });
});

test("snapshot parsing validates identity fields and fails open on unreadable files", () => {
  const parsed = parseOpenPrSnapshot([
    { number: 7, headRefName: "depvisor/prod-a", body: "body", mergeStateStatus: "DIRTY" },
    { number: -1, headRefName: "depvisor/prod-b", body: 42, mergeable: "MERGEABLE" },
    { headRefName: "" },
    null,
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.number, 7);
  assert.equal(parsed[0]?.conflicted, true);
  assert.equal(parsed[1]?.number, null);
  assert.equal(parsed[1]?.body, "");

  const dir = mkdtempSync(join(tmpdir(), "depvisor-open-pr-snapshot-"));
  const file = join(dir, "snapshot.json");
  writeFileSync(file, "{broken");
  assert.deepEqual(readOpenPrSnapshot(file), []);
  assert.deepEqual(readOpenPrSnapshot(undefined), []);
});

test("REST mergeable values normalize to the snapshot vocabulary", () => {
  assert.equal(normalizeRestMergeable(false), "CONFLICTING");
  assert.equal(normalizeRestMergeable(true), "MERGEABLE");
  for (const value of [null, undefined, "false", 0, {}]) {
    assert.equal(normalizeRestMergeable(value), "UNKNOWN");
  }
});
