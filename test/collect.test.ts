import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUpdate, parseOutdated, parsePnpmOutdated } from "../src/core/collect.ts";

test("classifyUpdate: patch/minor/major", () => {
  assert.equal(classifyUpdate("1.2.3", "1.2.4"), "patch");
  assert.equal(classifyUpdate("1.2.3", "1.3.0"), "minor");
  assert.equal(classifyUpdate("1.2.3", "2.0.0"), "major");
});

test("classifyUpdate: downgrades and unparseable versions are unknown", () => {
  assert.equal(classifyUpdate("2.0.0", "1.9.0"), "unknown"); // latest behind current
  assert.equal(classifyUpdate("MISSING", "1.0.0"), "unknown");
  assert.equal(classifyUpdate("1.0.0", ""), "unknown");
});

test("parseOutdated classifies dev vs prod and skips up-to-date entries", () => {
  const out = parseOutdated(
    {
      typescript: { current: "5.3.3", wanted: "5.3.3", latest: "5.9.0" },
      "lru-cache": { current: "7.18.3", wanted: "7.18.3", latest: "11.0.0" },
      same: { current: "1.0.0", wanted: "1.0.0", latest: "1.0.0" },
    },
    new Set(["typescript"]),
  );
  assert.deepEqual(
    out.map((c) => [c.name, c.kind, c.updateType]),
    [
      ["lru-cache", "prod", "major"],
      ["typescript", "dev", "minor"],
    ],
  );
});

test("parseOutdated handles workspace-style array entries", () => {
  const out = parseOutdated(
    { pkg: [{ current: "1.0.0", wanted: "1.0.1", latest: "1.0.1" }] },
    new Set(),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.updateType, "patch");
});

test("parsePnpmOutdated classifies via dependencyType and skips up-to-date entries", () => {
  // Shape verified against `pnpm outdated --format json` (pnpm 11).
  const out = parsePnpmOutdated({
    typescript: {
      current: "5.3.3",
      latest: "5.9.0",
      wanted: "5.3.3",
      isDeprecated: false,
      dependencyType: "devDependencies",
    },
    "lru-cache": {
      current: "7.18.3",
      latest: "11.0.0",
      wanted: "7.18.3",
      isDeprecated: false,
      dependencyType: "dependencies",
    },
    same: { current: "1.0.0", latest: "1.0.0", wanted: "1.0.0", dependencyType: "dependencies" },
  });
  assert.deepEqual(
    out.map((c) => [c.name, c.kind, c.updateType]),
    [
      ["lru-cache", "prod", "major"],
      ["typescript", "dev", "minor"],
    ],
  );
});
