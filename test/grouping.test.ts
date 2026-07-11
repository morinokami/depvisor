import { test } from "node:test";
import assert from "node:assert/strict";
import { groupCandidates, parseGroups, type GroupRule } from "../src/core/grouping.ts";
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

function rules(raw: string): GroupRule[] {
  const parsed = parseGroups(raw);
  assert.ok(parsed.ok, `expected '${raw}' to parse`);
  return parsed.rules;
}

function problems(raw: string): string[] {
  const parsed = parseGroups(raw);
  assert.ok(!parsed.ok, `expected '${raw}' to be rejected`);
  return parsed.problems;
}

test("parseGroups: one group per line, members split on spaces and commas", () => {
  assert.deepEqual(rules("react: react react-dom, @types/react"), [
    { name: "react", packages: ["react", "react-dom", "@types/react"] },
  ]);
});

test("parseGroups: blank lines and full-line comments are skipped", () => {
  assert.deepEqual(rules("# the react stack moves together\n\nreact: react react-dom\n"), [
    { name: "react", packages: ["react", "react-dom"] },
  ]);
});

test("parseGroups: empty input means no groups", () => {
  assert.deepEqual(rules(""), []);
});

test("parseGroups: every malformed line is rejected and named", () => {
  const all = problems(
    [
      "no-colon-here", // no ':' separator
      "bad name!: lodash", // name outside the branch-safe charset
      "empty:", // no members
    ].join("\n"),
  );
  assert.equal(all.length, 3);
  assert.ok(all.some((p) => p.includes("no-colon-here")));
  assert.ok(all.some((p) => p.includes("bad name!")));
  assert.ok(all.some((p) => p.includes("empty")));
});

test("parseGroups: names that break the branch mapping are rejected", () => {
  // Would produce a ref git rejects (git check-ref-format --branch):
  // a trailing '.', a '..' sequence, a '.lock'-suffixed component.
  for (const name of ["foo.", "foo..bar", "foo.lock"]) {
    const all = problems(`${name}: react`);
    assert.equal(all.length, 1, name);
    assert.ok(all[0]!.includes(`'${name}'`), name);
  }
  // slugify() trims trailing '-', so 'foo-'/'foo--' would collide with 'foo'
  // on the same branch across runs; leading '-'/'.' edges are rejected by the
  // same start/end-alphanumeric rule.
  for (const name of ["foo-", "foo--", "-foo", ".foo"]) {
    const all = problems(`${name}: react`);
    assert.equal(all.length, 1, name);
  }
  // Interior punctuation survives both git and slugify untouched.
  assert.deepEqual(rules("foo.bar-baz_v2: react"), [
    { name: "foo.bar-baz_v2", packages: ["react"] },
  ]);
  assert.deepEqual(rules("x: react"), [{ name: "x", packages: ["react"] }]);
});

test("parseGroups: invalid package names are rejected", () => {
  const all = problems("tools: lodash UPPER/bad");
  assert.equal(all.length, 1);
  assert.ok(all[0]!.includes("UPPER/bad"));
});

test("parseGroups: a package claimed twice fails closed, across and within groups", () => {
  const across = problems("a: react\nb: react-dom react");
  assert.ok(across.some((p) => p.includes("'react'") && p.includes("'a'") && p.includes("'b'")));

  const within = problems("a: react react");
  assert.ok(within.some((p) => p.includes("'react'")));
});

test("parseGroups: a duplicated group name fails closed", () => {
  const all = problems("a: react\na: lodash");
  assert.ok(all.some((p) => p.includes("'a'") && p.includes("more than once")));
});

test("user-declared groups bundle their members under group/<name>, majors included", () => {
  const groups = groupCandidates(
    [
      c({ name: "react", updateType: "major" }),
      c({ name: "react-dom", updateType: "major" }),
      c({ name: "@types/react", kind: "dev", updateType: "minor" }),
      c({ name: "lodash", updateType: "patch" }),
    ],
    rules("react: react react-dom @types/react"),
  );
  assert.deepEqual(
    groups.map((g) => g.key),
    ["group/react", "prod/lodash"],
  );
  assert.deepEqual(
    groups[0]!.members.map((m) => m.name),
    ["react", "react-dom", "@types/react"],
  );
});

test("the group key derives from the declared name, not from which members are present", () => {
  const declared = rules("react: react react-dom");
  const oneMember = groupCandidates([c({ name: "react-dom" })], declared);
  assert.deepEqual(
    oneMember.map((g) => g.key),
    ["group/react"],
  );
  // No member outdated -> the declared group simply does not appear.
  assert.deepEqual(groupCandidates([c({ name: "lodash" })], declared), [
    ...groupCandidates([c({ name: "lodash" })]),
  ]);
});

test("unknown update types are skipped even when declared in a group", () => {
  const groups = groupCandidates(
    [c({ name: "react", updateType: "unknown" }), c({ name: "react-dom" })],
    rules("react: react react-dom"),
  );
  assert.deepEqual(
    groups[0]!.members.map((m) => m.name),
    ["react-dom"],
  );
});
