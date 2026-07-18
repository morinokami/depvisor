import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedDependencyState,
  isDependencyStatePath,
  readDependencySnapshot,
  snapshotDependencyState,
} from "../src/core/dependency-state.ts";

test("recognizes dependency state across common updater ecosystems", () => {
  for (const path of [
    "package.json",
    "packages/a/pnpm-lock.yaml",
    "requirements-dev.txt",
    "Cargo.toml",
    "go.sum",
    "src/App.csproj",
    "gradle/libs.versions.toml",
    "Dockerfile.node",
    "Package.swift",
    "Package.resolved",
    ".terraform.lock.hcl",
    "Directory.Packages.props",
    ".github/dependabot.yml",
    ".npmrc",
    "apps/web/.npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    ".pnpmfile.mjs",
  ]) {
    assert.equal(isDependencyStatePath(path), true, path);
  }
  assert.equal(isDependencyStatePath("src/index.ts"), false);
  assert.equal(isDependencyStatePath(".github/workflows/ci.yml"), false);
});

test("freezes updater-owned paths and recognized manifests", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-state-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "package.json"), '{"dependencies":{"x":"1"}}');
  writeFileSync(join(repo, "src/index.ts"), "export const value = 1;\n");
  const snapshot = snapshotDependencyState(repo, ["src/index.ts"]);
  assert.deepEqual(changedDependencyState(repo, snapshot), []);

  writeFileSync(join(repo, "src/index.ts"), "export const value = 2;\n");
  writeFileSync(join(repo, "package.json"), '{"dependencies":{"x":"2"}}');
  assert.deepEqual(changedDependencyState(repo, snapshot), ["package.json", "src/index.ts"]);
});

test("detects a newly-created dependency file", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-state-new-"));
  const snapshot = snapshotDependencyState(repo);
  writeFileSync(join(repo, "uv.lock"), "version = 1\n");
  assert.deepEqual(changedDependencyState(repo, snapshot), ["uv.lock"]);
});

test("reads a valid snapshot and rejects path traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "depvisor-state-read-"));
  const file = join(root, "state.json");
  writeFileSync(file, JSON.stringify({ version: 1, files: { "package.json": null } }));
  assert.deepEqual(readDependencySnapshot(file), {
    version: 1,
    files: { "package.json": null },
  });
  writeFileSync(file, JSON.stringify({ version: 1, files: { "../outside": null } }));
  assert.throws(() => readDependencySnapshot(file), /Invalid dependency snapshot entry/);
});
