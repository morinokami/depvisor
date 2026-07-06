import { test } from "node:test";
import assert from "node:assert/strict";
import { applyIgnore, describeIgnore, parseIgnore } from "../src/core/ignore.ts";
import type { Candidate } from "../src/core/types.ts";

function cand(partial: Partial<Candidate> & { name: string }): Candidate {
  return {
    current: "1.0.0",
    latest: "2.0.0",
    kind: "prod",
    updateType: "major",
    locations: [""],
    ...partial,
  };
}

test("parseIgnore accepts bare names and name@<major>, skipping blank lines", () => {
  const parsed = parseIgnore("lru-cache\n\n  @babel/core@8  \nsemver@7\n");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.rules, [
    { name: "lru-cache", major: null },
    { name: "@babel/core", major: 8 },
    { name: "semver", major: 7 },
  ]);
});

test("parseIgnore returns an empty rule set for empty/whitespace input", () => {
  for (const raw of ["", "   ", "\n\n"]) {
    const parsed = parseIgnore(raw);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.rules, []);
  }
});

test("parseIgnore handles a scoped name with no major", () => {
  const parsed = parseIgnore("@types/node");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.rules, [{ name: "@types/node", major: null }]);
});

test("parseIgnore fails closed on ranges, full versions, and empty majors", () => {
  for (const raw of ["lru-cache@^11", "lru-cache@11.0.0", "lru-cache@", "lru-cache@1.2", "pkg@x"]) {
    const parsed = parseIgnore(raw);
    assert.ok(!parsed.ok, `expected failure for '${raw}'`);
    assert.deepEqual(parsed.invalid, [raw.trim()]);
  }
});

test("parseIgnore rejects structurally invalid names and reports every bad entry", () => {
  const parsed = parseIgnore("good-name\n../etc/passwd\n@\nbad name@1");
  assert.ok(!parsed.ok);
  // Names go through npm grammar (isValidNpmName): path traversal, a bare '@',
  // and a name with a space are all rejected; the one valid line does not
  // rescue the input.
  assert.deepEqual(parsed.invalid, ["../etc/passwd", "@", "bad name@1"]);
});

test("applyIgnore drops a bare-name candidate regardless of version", () => {
  const candidates = [
    cand({ name: "lru-cache", current: "10.0.0", latest: "11.0.0" }),
    cand({ name: "semver", current: "7.5.0", latest: "7.6.0" }),
  ];
  const { kept, ignored } = applyIgnore(candidates, [{ name: "lru-cache", major: null }]);
  assert.deepEqual(
    kept.map((c) => c.name),
    ["semver"],
  );
  assert.deepEqual(
    ignored.map((c) => c.name),
    ["lru-cache"],
  );
});

test("applyIgnore with name@<major> drops only the matching target major", () => {
  const rules = [{ name: "lru-cache", major: 11 }];
  // latest is v11 → ignored.
  const toEleven = applyIgnore(
    [cand({ name: "lru-cache", current: "10.0.0", latest: "11.2.0" })],
    rules,
  );
  assert.equal(toEleven.kept.length, 0);
  assert.equal(toEleven.ignored.length, 1);
  // latest is still v10 → kept (the rule only blocks the v11 target).
  const toTen = applyIgnore(
    [cand({ name: "lru-cache", current: "10.0.0", latest: "10.4.0" })],
    rules,
  );
  assert.equal(toTen.kept.length, 1);
  assert.equal(toTen.ignored.length, 0);
});

test("applyIgnore matches name@<major> against the latest core, prerelease included", () => {
  const rules = [{ name: "next", major: 15 }];
  const { ignored } = applyIgnore(
    [cand({ name: "next", current: "14.0.0", latest: "15.0.0-canary.1" })],
    rules,
  );
  assert.deepEqual(
    ignored.map((c) => c.name),
    ["next"],
  );
});

test("applyIgnore with no rules keeps everything (fresh copy)", () => {
  const candidates = [cand({ name: "a" }), cand({ name: "b" })];
  const { kept, ignored } = applyIgnore(candidates, []);
  assert.deepEqual(
    kept.map((c) => c.name),
    ["a", "b"],
  );
  assert.notEqual(kept, candidates); // a copy, not the same array reference
  assert.equal(ignored.length, 0);
});

test("describeIgnore lists dropped packages, empty when nothing was ignored", () => {
  assert.equal(describeIgnore([]), "");
  const note = describeIgnore([
    cand({ name: "lru-cache", current: "10.0.0", latest: "11.0.0" }),
    cand({ name: "left-pad", current: "1.0.0", latest: "1.3.0" }),
  ]);
  assert.match(note, /^ignore: skipped /);
  assert.match(note, /lru-cache 10\.0\.0 -> 11\.0\.0/);
  assert.match(note, /left-pad 1\.0\.0 -> 1\.3\.0/);
});
