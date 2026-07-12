import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunWorkspaceMap,
  classifyUpdate,
  collectCandidates,
  parseBunOutdated,
  parseOutdated,
  parsePnpmOutdated,
} from "../src/core/collect.ts";
import { npmToolchain, type PmToolchain } from "../src/core/pm.ts";

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

test("parseOutdated classifies dev vs prod via --long type and skips up-to-date entries", () => {
  // Shape verified against `npm outdated --json --long` (npm 11).
  const out = parseOutdated({
    typescript: {
      current: "5.3.3",
      wanted: "5.3.3",
      latest: "5.9.0",
      type: "devDependencies",
      dependedByLocation: "",
    },
    "lru-cache": {
      current: "7.18.3",
      wanted: "7.18.3",
      latest: "11.0.0",
      type: "dependencies",
      dependedByLocation: "",
    },
    same: {
      current: "1.0.0",
      wanted: "1.0.0",
      latest: "1.0.0",
      type: "dependencies",
      dependedByLocation: "",
    },
  });
  assert.deepEqual(
    out.map((c) => [c.name, c.kind, c.updateType]),
    [
      ["lru-cache", "prod", "major"],
      ["typescript", "dev", "minor"],
    ],
  );
  // Root-declared dependencies carry the "" location.
  assert.deepEqual(
    out.map((c) => c.locations),
    [[""], [""]],
  );
});

test("parseOutdated merges a dependency declared across workspaces", () => {
  // npm reports a name with differing versions as an array (one per workspace).
  const out = parseOutdated({
    "left-pad": [
      {
        current: "1.2.0",
        latest: "1.3.0",
        type: "dependencies",
        dependedByLocation: "packages/b",
      },
      {
        current: "1.0.0",
        latest: "1.3.0",
        type: "dependencies",
        dependedByLocation: "packages/a",
      },
    ],
  });
  assert.equal(out.length, 1);
  const c = out[0]!;
  assert.equal(c.current, "1.0.0"); // lowest → the most conservative (largest) jump
  assert.equal(c.latest, "1.3.0");
  assert.equal(c.kind, "prod");
  assert.deepEqual(c.locations, ["packages/a", "packages/b"]); // union, sorted
  // Both distinct currents are retained so advisory matching can probe each
  // workspace-current, not just the lowest.
  assert.deepEqual(c.currents, ["1.0.0", "1.2.0"]);
});

test("parseOutdated: dev in one workspace, prod in another → prod (no -D)", () => {
  const out = parseOutdated({
    pkg: [
      {
        current: "1.0.0",
        latest: "2.0.0",
        type: "devDependencies",
        dependedByLocation: "packages/a",
      },
      { current: "1.0.0", latest: "2.0.0", type: "dependencies", dependedByLocation: "packages/b" },
    ],
  });
  assert.equal(out[0]!.kind, "prod");
});

test("parseOutdated: dev in every workspace → dev", () => {
  const out = parseOutdated({
    pkg: [
      {
        current: "1.1.0",
        latest: "2.0.0",
        type: "devDependencies",
        dependedByLocation: "packages/b",
      },
      {
        current: "1.0.0",
        latest: "2.0.0",
        type: "devDependencies",
        dependedByLocation: "packages/a",
      },
    ],
  });
  assert.equal(out[0]!.kind, "dev");
  assert.equal(out[0]!.current, "1.0.0");
  assert.deepEqual(out[0]!.locations, ["packages/a", "packages/b"]);
});

test("parseOutdated fails closed on a malformed package entry", () => {
  assert.throws(() => parseOutdated({ broken: null }), /malformed npm outdated entry for broken/);
});

// A single-package repo under `-r`: every row's Workspace is the repo's own
// name, which resolves to the root "".
const ROOT_WS = new Map([["app", ""]]);

test("parseBunOutdated: parses the -r table, strips (dev), targets Latest, resolves workspace", () => {
  // Table captured verbatim from `bun outdated -r` v1.3.14 (piped, no TTY).
  const out = parseBunOutdated(
    [
      "bun outdated v1.3.14 (0d9b296a)",
      "|-----------------------------------------------------------|",
      "| Package           | Current | Update  | Latest | Workspace |",
      "|-------------------|---------|---------|--------|-----------|",
      "| @isaacs/ttlcache  | 1.4.1   | 1.4.1   | 2.1.5  | app       |",
      "|-------------------|---------|---------|--------|-----------|",
      "| @types/node (dev) | 22.20.0 | 22.20.0 | 26.1.0 | app       |",
      "|-----------------------------------------------------------|",
    ].join("\n"),
    ROOT_WS,
  );
  assert.deepEqual(
    out.map((c) => [c.name, c.current, c.latest, c.kind, c.updateType]),
    [
      ["@isaacs/ttlcache", "1.4.1", "2.1.5", "prod", "major"],
      ["@types/node", "22.20.0", "26.1.0", "dev", "major"],
    ],
  );
  assert.deepEqual(
    out.map((c) => c.locations),
    [[""], [""]],
  );
});

test("parseBunOutdated: merges a package across workspaces (union locations, lowest current)", () => {
  const ws = new Map([
    ["@mono/a", "packages/a"],
    ["@mono/b", "packages/b"],
  ]);
  const out = parseBunOutdated(
    [
      "| Package  | Current | Update | Latest | Workspace |",
      "| left-pad | 1.2.0   | 1.2.0  | 1.3.0  | @mono/b   |",
      "| left-pad | 1.0.0   | 1.0.0  | 1.3.0  | @mono/a   |",
    ].join("\n"),
    ws,
  );
  assert.equal(out.length, 1);
  const c = out[0]!;
  assert.equal(c.current, "1.0.0"); // lowest → most conservative classification
  assert.equal(c.latest, "1.3.0");
  assert.equal(c.kind, "prod");
  assert.deepEqual(c.locations, ["packages/a", "packages/b"]);
});

test("parseBunOutdated: banner-only output (everything current) yields no candidates", () => {
  assert.deepEqual(parseBunOutdated("bun outdated v1.3.14 (0d9b296a)", ROOT_WS), []);
});

test("parseBunOutdated: rows whose Latest is not ahead of Current are skipped", () => {
  const out = parseBunOutdated(
    [
      "| Package | Current | Update | Latest | Workspace |",
      "| pkg     | 1.0.0   | 1.0.0  | 1.0.0  | app       |",
    ].join("\n"),
    ROOT_WS,
  );
  assert.deepEqual(out, []);
});

test("parseBunOutdated: fails closed on format drift and unmapped workspaces", () => {
  // The 4-column non-recursive form (no Workspace) is now rejected — depvisor
  // always passes -r.
  assert.throws(
    () =>
      parseBunOutdated(
        ["| Package | Current | Update | Latest |", "| pkg | 1.0.0 | 1.0.1 | 1.0.1 |"].join("\n"),
        ROOT_WS,
      ),
    /unexpected bun outdated columns/,
  );
  // A line that is neither banner, border, nor table row (warning, error, …).
  assert.throws(
    () => parseBunOutdated("error: something unexpected", ROOT_WS),
    /unrecognized line/,
  );
  // A Package annotation other than (dev), e.g. a future catalog marker.
  assert.throws(
    () =>
      parseBunOutdated(
        [
          "| Package         | Current | Update | Latest | Workspace |",
          "| react (catalog) | 18.0.0  | 18.0.0 | 19.0.0 | app       |",
        ].join("\n"),
        ROOT_WS,
      ),
    /unknown package annotation/,
  );
  // A workspace name with no path mapping — refuse rather than default to root
  // (which would scope the update to the wrong manifest).
  assert.throws(
    () =>
      parseBunOutdated(
        [
          "| Package | Current | Update | Latest | Workspace   |",
          "| pkg     | 1.0.0   | 1.0.0  | 2.0.0  | @mono/ghost |",
        ].join("\n"),
        ROOT_WS,
      ),
    /unknown workspace/,
  );
  // A row with missing cells.
  assert.throws(
    () =>
      parseBunOutdated(
        ["| Package | Current | Update | Latest | Workspace |", "| pkg | 1.0.0 |"].join("\n"),
        ROOT_WS,
      ),
    /malformed bun outdated row/,
  );
});

test("bunWorkspaceMap resolves workspace names to paths and the root to ''", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-bunws-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  );
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  mkdirSync(join(repo, "packages/b"), { recursive: true });
  writeFileSync(join(repo, "packages/a/package.json"), JSON.stringify({ name: "@mono/a" }));
  writeFileSync(join(repo, "packages/b/package.json"), JSON.stringify({ name: "@mono/b" }));
  const map = bunWorkspaceMap(repo);
  assert.equal(map.get("root"), "");
  assert.equal(map.get("@mono/a"), "packages/a");
  assert.equal(map.get("@mono/b"), "packages/b");
});

test("bunWorkspaceMap throws on an unsupported glob pattern (fail-closed)", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-bunws-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/**"] }),
  );
  assert.throws(() => bunWorkspaceMap(repo), /unsupported bun workspaces pattern/);
});

test("bunWorkspaceMap maps the root even when the root package omits a name", () => {
  // A private monorepo root often has no `name`; `bun outdated -r` then labels
  // its root dependencies with an empty Workspace cell, which must still resolve.
  const repo = mkdtempSync(join(tmpdir(), "depvisor-bunws-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  writeFileSync(join(repo, "packages/a/package.json"), JSON.stringify({ name: "@mono/a" }));
  const map = bunWorkspaceMap(repo);
  assert.equal(map.get(""), ""); // empty Workspace cell → root path
  assert.equal(map.get("@mono/a"), "packages/a");
});

test("parseBunOutdated: an empty Workspace cell (unnamed private root) resolves to the root", () => {
  // Regression: previously threw `unknown workspace ""` for a valid repo whose
  // root package.json omits `name`.
  const out = parseBunOutdated(
    [
      "| Package | Current | Update | Latest | Workspace |",
      "| ms      | 2.0.0   | 2.0.0  | 2.1.3  |           |",
    ].join("\n"),
    new Map([["", ""]]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "ms");
  assert.deepEqual(out[0]!.locations, [""]);
});

test("parsePnpmOutdated classifies via dependencyType and relativizes dependent locations", () => {
  // Shape verified against `pnpm outdated -r --format json` (pnpm 11).
  const out = parsePnpmOutdated(
    {
      typescript: {
        current: "5.3.3",
        latest: "5.9.0",
        wanted: "5.3.3",
        isDeprecated: false,
        dependencyType: "devDependencies",
        dependentPackages: [{ name: "@mono/a", location: "/repo/packages/a" }],
      },
      "lru-cache": {
        current: "7.18.3",
        latest: "11.0.0",
        wanted: "7.18.3",
        isDeprecated: false,
        dependencyType: "dependencies",
        dependentPackages: [{ name: "root", location: "/repo" }],
      },
      same: {
        current: "1.0.0",
        latest: "1.0.0",
        wanted: "1.0.0",
        dependencyType: "dependencies",
        dependentPackages: [{ name: "root", location: "/repo" }],
      },
    },
    "/repo",
  );
  assert.deepEqual(
    out.map((c) => [c.name, c.kind, c.updateType]),
    [
      ["lru-cache", "prod", "major"],
      ["typescript", "dev", "minor"],
    ],
  );
  // Absolute dependent paths become repo-relative; the root package is "".
  assert.deepEqual(
    out.map((c) => c.locations),
    [[""], ["packages/a"]],
  );
});

test("parsePnpmOutdated defaults to the root location when no dependents are listed", () => {
  const out = parsePnpmOutdated(
    { pkg: { current: "1.0.0", latest: "2.0.0", dependencyType: "dependencies" } },
    "/repo",
  );
  assert.deepEqual(out[0]!.locations, [""]);
});

test("parsePnpmOutdated fails closed on a malformed package entry", () => {
  assert.throws(
    () => parsePnpmOutdated({ broken: null }, "/repo"),
    /malformed pnpm outdated entry for broken/,
  );
});

test("collectCandidates fails closed on npm's --json error object (registry outage)", () => {
  // npm reports hard failures as `{"error":{code,summary,detail}}` on STDOUT
  // with the same exit 1 as the normal "updates exist" path; parsed naively it
  // reads as zero candidates and a registry outage becomes a green "no
  // updates" run. Fake the spawn with a node one-liner printing the real shape.
  const repo = mkdtempSync(join(tmpdir(), "depvisor-collect-"));
  const errorJson = JSON.stringify({
    error: { code: "ECONNREFUSED", summary: "request to https://registry/x failed" },
  });
  const pm: PmToolchain = {
    ...npmToolchain,
    outdatedArgv: ["node", "-e", `console.log(${JSON.stringify(errorJson)}); process.exit(1)`],
  };
  assert.throws(() => collectCandidates(repo, pm), /ECONNREFUSED/);
});

test("collectCandidates fails closed on empty output with a non-zero exit", () => {
  // npm/pnpm print JSON (at least `{}`) even when everything is current, so
  // empty output plus a non-zero exit is a hard failure, never "no updates".
  const repo = mkdtempSync(join(tmpdir(), "depvisor-collect-"));
  const pm: PmToolchain = { ...npmToolchain, outdatedArgv: ["node", "-e", "process.exit(2)"] };
  assert.throws(() => collectCandidates(repo, pm), /produced no output \(exit 2\)/);
});

test("collectCandidates still parses a real dependency that happens to be named 'error'", () => {
  // The error-shape detection must not misfire on the real npm package `error`:
  // an outdated ENTRY carries current/latest, which npm's error object lacks.
  const repo = mkdtempSync(join(tmpdir(), "depvisor-collect-"));
  const outdatedJson = JSON.stringify({
    error: {
      current: "7.0.0",
      wanted: "7.0.0",
      latest: "10.4.0",
      type: "dependencies",
      dependedByLocation: "",
    },
  });
  const pm: PmToolchain = {
    ...npmToolchain,
    outdatedArgv: ["node", "-e", `console.log(${JSON.stringify(outdatedJson)}); process.exit(1)`],
  };
  const out = collectCandidates(repo, pm);
  assert.deepEqual(
    out.map((c) => [c.name, c.current, c.latest]),
    [["error", "7.0.0", "10.4.0"]],
  );
});
