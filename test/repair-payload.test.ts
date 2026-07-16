import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameRepairChanges, type RepairChanges } from "../src/core/git.ts";
import {
  readRepairPayload,
  writeRepairPayload,
  type RepairPayload,
} from "../src/core/repair-payload.ts";

function payload(changes: RepairChanges): RepairPayload {
  return {
    version: 2,
    repository: "owner/repo",
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
    headRepository: "owner/repo",
    headRef: "renovate/example",
    headSha: "a".repeat(40),
    agent: {
      verdict: "ready",
      summary: "The update is ready.",
      upstream_changes: [],
      changes_made: [],
      verification: [],
      risks: [],
    },
    changes,
  };
}

test("repair changes survive a payload write/read round trip", () => {
  const changes: RepairChanges = {
    patch: "",
    newFiles: [],
    paths: [],
  };
  const file = join(mkdtempSync(join(tmpdir(), "depvisor-payload-")), "repair.json");
  writeRepairPayload(file, payload(changes));
  const roundTrip = readRepairPayload(file).changes;
  assert.deepEqual(roundTrip, changes);
  assert.equal(sameRepairChanges(changes, roundTrip), true);
});

test("repair comparison rejects changed new-file bytes", () => {
  const changes: RepairChanges = {
    patch: "patch",
    paths: ["new.txt"],
    newFiles: [
      {
        path: "new.txt",
        contentBase64: Buffer.from("before").toString("base64"),
        executable: false,
        symlink: false,
      },
    ],
  };
  const changed: RepairChanges = {
    ...changes,
    newFiles: [
      {
        ...changes.newFiles[0]!,
        contentBase64: Buffer.from("after").toString("base64"),
      },
    ],
  };
  assert.equal(sameRepairChanges(changes, changed), false);
});
