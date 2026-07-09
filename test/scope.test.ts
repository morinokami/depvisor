import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFixScope } from "../src/core/scope.ts";

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
