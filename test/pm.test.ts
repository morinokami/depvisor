import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPackageManager, npmToolchain, pnpmToolchain } from "../src/core/pm.ts";

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-pm-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content);
  }
  return repo;
}

function pmNameOf(repo: string): string {
  const detected = detectPackageManager(repo);
  assert.equal(detected.ok, true, JSON.stringify(detected));
  return detected.ok ? detected.pm.name : "";
}

test("detect: lockfile decides when there is no packageManager field", () => {
  assert.equal(pmNameOf(repoWith({ "package-lock.json": "{}" })), "npm");
  assert.equal(pmNameOf(repoWith({ "npm-shrinkwrap.json": "{}" })), "npm");
  assert.equal(pmNameOf(repoWith({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })), "pnpm");
});

test("detect: packageManager field (corepack standard) wins over lockfiles", () => {
  const repo = repoWith({
    "package.json": `{"packageManager":"pnpm@9.0.0"}`,
    "package-lock.json": "{}", // stale leftover — the field is authoritative
  });
  assert.equal(pmNameOf(repo), "pnpm");
});

test("detect: no lockfile and no field falls back to npm, the ecosystem default", () => {
  assert.equal(pmNameOf(repoWith({ "package.json": "{}" })), "npm");
});

test("detect: malformed packageManager field is ignored, lockfile decides", () => {
  const repo = repoWith({
    "package.json": `{"packageManager":"something-weird"}`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  assert.equal(pmNameOf(repo), "pnpm");
});

test("detect: yarn and bun are recognized but refused as unsupported", () => {
  for (const files of [
    { "yarn.lock": "" },
    { "bun.lockb": "" },
    { "package.json": `{"packageManager":"yarn@4.0.0"}` },
  ]) {
    const detected = detectPackageManager(repoWith(files));
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.equal(detected.status, "unsupported-package-manager");
      assert.match(detected.summary, /npm and pnpm/);
    }
  }
});

test("detect: multiple package managers' lockfiles without a field is a refusal, not a guess", () => {
  const detected = detectPackageManager(
    repoWith({
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    }),
  );
  assert.equal(detected.ok, false);
  if (!detected.ok) {
    assert.equal(detected.status, "ambiguous-package-manager");
    assert.match(detected.summary, /package-lock\.json.*pnpm-lock\.yaml/);
  }
});

test("installCommand: requires a committed lockfile (null = auto must fail closed)", () => {
  assert.equal(npmToolchain.installCommand(repoWith({ "package-lock.json": "{}" })), "npm ci");
  assert.equal(npmToolchain.installCommand(repoWith({ "npm-shrinkwrap.json": "{}" })), "npm ci");
  // A bare install would create package-lock.json and dirty the pre-agent tree.
  assert.equal(npmToolchain.installCommand(repoWith({})), null);

  assert.equal(
    pnpmToolchain.installCommand(repoWith({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })),
    "pnpm install --frozen-lockfile",
  );
  // `--frozen-lockfile` errors outright when the lockfile is absent
  // (e.g. a packageManager-field-only repo).
  assert.equal(pnpmToolchain.installCommand(repoWith({})), null);

  // The advertised escape hatch must itself create no lockfile.
  assert.equal(npmToolchain.noLockfileInstall, "npm install --package-lock=false");
  assert.equal(pnpmToolchain.noLockfileInstall, "pnpm install --no-lockfile");
});

test("toolchains: per-PM commands and manifest sets", () => {
  assert.equal(npmToolchain.runScript("test"), "npm run test");
  assert.equal(pnpmToolchain.runScript("test"), "pnpm run test");
  assert.ok(npmToolchain.manifests.includes("package-lock.json"));
  assert.ok(pnpmToolchain.manifests.includes("pnpm-lock.yaml"));
  assert.ok(!pnpmToolchain.manifests.includes("package-lock.json"));
});
