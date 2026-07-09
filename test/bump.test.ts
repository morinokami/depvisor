import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdatePlan, type UpdatePlan } from "../src/core/bump.ts";

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-bump-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content);
  }
  return repo;
}

function workspaceYaml(repo: string): string {
  return readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
}

// A plan literal that only edits catalogs (no commands) — the round-trip cases.
const catalogPlan = (catalogEdits: UpdatePlan["catalogEdits"], pinExact = false): UpdatePlan => ({
  catalogEdits,
  commands: [],
  pinExact,
});

test("applyUpdatePlan rewrites a catalog entry, preserving comments and range style", () => {
  const repo = repoWith({
    "pnpm-workspace.yaml":
      "# managed catalog\npackages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0 # pinned\n  chalk: ~4.1.2\n",
  });
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "semver", target: "7.7.3" }]));
  assert.deepEqual(res, { ok: true });
  const out = workspaceYaml(repo);
  assert.match(out, /semver: \^7\.7\.3 # pinned/); // caret prefix + inline comment kept
  assert.match(out, /# managed catalog/); // leading comment kept
  assert.match(out, /chalk: ~4\.1\.2/); // unrelated entry untouched
});

test("applyUpdatePlan writes an exact target when the entry has no range prefix", () => {
  const repo = repoWith({ "pnpm-workspace.yaml": "catalog:\n  semver: 7.3.0\n" });
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "semver", target: "7.7.3" }]));
  assert.deepEqual(res, { ok: true });
  assert.match(workspaceYaml(repo), /semver: 7\.7\.3/);
});

test("applyUpdatePlan forces an exact entry under pinExact even when a range existed", () => {
  const repo = repoWith({ "pnpm-workspace.yaml": "catalog:\n  semver: ^7.3.0\n" });
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "semver", target: "7.7.3" }], true));
  assert.deepEqual(res, { ok: true });
  const out = workspaceYaml(repo);
  assert.match(out, /semver: 7\.7\.3/);
  assert.doesNotMatch(out, /\^7\.7\.3/);
});

test("applyUpdatePlan edits an entry inside a named catalogs group", () => {
  const repo = repoWith({ "pnpm-workspace.yaml": "catalogs:\n  react:\n    react: ^18.0.0\n" });
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "react", target: "19.0.0" }]));
  assert.deepEqual(res, { ok: true });
  assert.match(workspaceYaml(repo), /react: \^19\.0\.0/);
});

test("applyUpdatePlan fails closed on a missing catalog entry", () => {
  const repo = repoWith({ "pnpm-workspace.yaml": "catalog:\n  chalk: ^4.1.2\n" });
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "semver", target: "7.7.3" }]));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.step, /catalog edit/);
    assert.equal(res.code, null);
    assert.match(res.outputTail, /no catalog entry for "semver"/);
  }
});

test("applyUpdatePlan does not run commands when a catalog edit fails", () => {
  const repo = repoWith({ "pnpm-workspace.yaml": "catalog:\n  chalk: ^4.1.2\n" });
  const res = applyUpdatePlan(repo, {
    catalogEdits: [{ name: "semver", target: "7.7.3" }],
    commands: [["node", "-e", 'require("fs").writeFileSync("ran.txt","x")']],
    pinExact: false,
  });
  assert.equal(res.ok, false);
  assert.equal(
    existsSync(join(repo, "ran.txt")),
    false,
    "catalog edits are applied before commands; a failed edit must short-circuit",
  );
});

test("applyUpdatePlan fails closed on a non-string catalog value", () => {
  const repo = repoWith({ "pnpm-workspace.yaml": "catalog:\n  semver:\n    nested: true\n" });
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "semver", target: "7.7.3" }]));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.outputTail, /not a string/);
});

test("applyUpdatePlan fails closed on an unparseable pnpm-workspace.yaml", () => {
  // Duplicate keys are a hard yaml error under the default schema.
  const repo = repoWith({ "pnpm-workspace.yaml": "catalog:\n  a: 1\n  a: 2\n" });
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "a", target: "3" }]));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.outputTail, /unparseable/);
});

test("applyUpdatePlan fails closed when pnpm-workspace.yaml is absent", () => {
  const repo = repoWith({});
  const res = applyUpdatePlan(repo, catalogPlan([{ name: "a", target: "3" }]));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.outputTail, /cannot read/);
});

test("applyUpdatePlan runs commands in order and returns ok on success", () => {
  const repo = repoWith({});
  const res = applyUpdatePlan(repo, {
    catalogEdits: [],
    commands: [
      ["node", "-e", 'require("fs").writeFileSync("a.txt","1")'],
      ["node", "-e", 'require("fs").writeFileSync("b.txt","2")'],
    ],
    pinExact: false,
  });
  assert.deepEqual(res, { ok: true });
  assert.ok(existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt")));
});

test("applyUpdatePlan reports a failing command with its step, code, and output tail", () => {
  const repo = repoWith({});
  const res = applyUpdatePlan(repo, {
    catalogEdits: [],
    commands: [["node", "-e", "console.error('boom'); process.exit(3)"]],
    pinExact: false,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.step, "node -e console.error('boom'); process.exit(3)");
    assert.equal(res.code, 3);
    assert.match(res.outputTail, /boom/);
  }
});

test("applyUpdatePlan stops at the first failing command", () => {
  const repo = repoWith({});
  const res = applyUpdatePlan(repo, {
    catalogEdits: [],
    commands: [
      ["node", "-e", "process.exit(1)"],
      ["node", "-e", 'require("fs").writeFileSync("after.txt","x")'],
    ],
    pinExact: false,
  });
  assert.equal(res.ok, false);
  assert.equal(existsSync(join(repo, "after.txt")), false, "no command runs after a failure");
});

test("applyUpdatePlan reports a command that cannot be launched with a null code", () => {
  const repo = repoWith({});
  const res = applyUpdatePlan(repo, {
    catalogEdits: [],
    commands: [["depvisor-no-such-command-xyz", "--nope"]],
    pinExact: false,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, null);
    assert.equal(res.step, "depvisor-no-such-command-xyz --nope");
  }
});

test("applyUpdatePlan bounds the output tail to the last ~4000 chars", () => {
  const repo = repoWith({});
  const res = applyUpdatePlan(repo, {
    catalogEdits: [],
    commands: [["node", "-e", "process.stdout.write('x'.repeat(5000)); process.exit(1)"]],
    pinExact: false,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.outputTail.length, 4000);
});
