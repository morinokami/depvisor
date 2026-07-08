import { test } from "node:test";
import assert from "node:assert/strict";
import { groupCandidates } from "../src/core/grouping.ts";
import type { Candidate } from "../src/core/types.ts";

function c(partial: Partial<Candidate> & { name: string }): Candidate {
  return {
    current: "1.0.0",
    latest: "1.1.0",
    kind: "prod",
    updateType: "minor",
    locations: [""],
    ...partial,
  };
}

test("major updates are isolated per package", () => {
  const groups = groupCandidates([
    c({ name: "lru-cache", updateType: "major" }),
    c({ name: "chalk", updateType: "major" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["major/chalk", "major/lru-cache"],
  );
});

test("non-major updates are individual per package, dev and prod alike", () => {
  const groups = groupCandidates([
    c({ name: "typescript", kind: "dev", updateType: "minor" }),
    c({ name: "vitest", kind: "dev", updateType: "patch" }),
    c({ name: "semver", kind: "prod", updateType: "minor" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["dev/typescript", "dev/vitest", "prod/semver"],
  );
  for (const g of groups) assert.equal(g.members.length, 1);
});

test("@types/* packages get no preset: individual like any other dep", () => {
  const groups = groupCandidates([
    c({ name: "@types/semver", kind: "dev", updateType: "patch" }),
    c({ name: "@types/react", kind: "dev", updateType: "minor" }),
    c({ name: "@types/node", kind: "prod", updateType: "minor" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["dev/@types/react", "dev/@types/semver", "prod/@types/node"],
  );
});

test("unknown update types never reach a group (could be a downgrade)", () => {
  const groups = groupCandidates([
    c({ name: "weird", updateType: "unknown" }),
    c({ name: "ok", updateType: "patch", kind: "dev" }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]!.members.map((m) => m.name),
    ["ok"],
  );
});
