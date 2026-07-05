import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUpdate,
  parseBunOutdated,
  parseOutdated,
  parsePnpmOutdated,
} from "../src/core/collect.ts";

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

test("parseBunOutdated: parses the table, strips the (dev) marker, targets the Latest column", () => {
  // Table captured verbatim from `bun outdated` v1.3.14 (piped, no TTY).
  const out = parseBunOutdated(
    [
      "bun outdated v1.3.14 (0d9b296a)",
      "|------------------------------------------------|",
      "| Package           | Current | Update  | Latest |",
      "|-------------------|---------|---------|--------|",
      "| @isaacs/ttlcache  | 1.4.1   | 1.4.1   | 2.1.5  |",
      "|-------------------|---------|---------|--------|",
      "| @types/node (dev) | 22.20.0 | 22.20.0 | 26.1.0 |",
      "|------------------------------------------------|",
    ].join("\n"),
  );
  assert.deepEqual(
    out.map((c) => [c.name, c.current, c.latest, c.kind, c.updateType]),
    [
      ["@isaacs/ttlcache", "1.4.1", "2.1.5", "prod", "major"],
      ["@types/node", "22.20.0", "26.1.0", "dev", "major"],
    ],
  );
});

test("parseBunOutdated: banner-only output (everything current) yields no candidates", () => {
  assert.deepEqual(parseBunOutdated("bun outdated v1.3.14 (0d9b296a)"), []);
});

test("parseBunOutdated: rows whose Latest is not ahead of Current are skipped", () => {
  const out = parseBunOutdated(
    ["| Package | Current | Update | Latest |", "| pkg     | 1.0.0   | 1.0.0  | 1.0.0  |"].join(
      "\n",
    ),
  );
  assert.deepEqual(out, []);
});

test("parseBunOutdated: fails closed on format drift", () => {
  // A changed column set, e.g. the Workspace column of `-r` mode.
  assert.throws(
    () =>
      parseBunOutdated(
        [
          "| Package | Current | Update | Latest | Workspace |",
          "| pkg     | 1.0.0   | 1.0.1  | 1.0.1  | root      |",
        ].join("\n"),
      ),
    /unexpected bun outdated columns/,
  );
  // A line that is neither banner, border, nor table row (warning, error, …).
  assert.throws(() => parseBunOutdated("error: something unexpected"), /unrecognized line/);
  // A Package annotation other than (dev), e.g. a future catalog marker.
  assert.throws(
    () =>
      parseBunOutdated(
        [
          "| Package         | Current | Update | Latest |",
          "| react (catalog) | 18.0.0  | 18.0.0 | 19.0.0 |",
        ].join("\n"),
      ),
    /unknown package annotation/,
  );
  // A row with missing cells.
  assert.throws(
    () =>
      parseBunOutdated(["| Package | Current | Update | Latest |", "| pkg | 1.0.0 |"].join("\n")),
    /malformed bun outdated row/,
  );
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
