import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_PM_LOCKFILES,
  bunToolchain,
  detectPackageManager,
  npmToolchain,
  pnpmToolchain,
  UNSUPPORTED_PM_LOCKFILES,
} from "../src/core/pm.ts";

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
  assert.equal(pmNameOf(repoWith({ "bun.lock": "{}" })), "bun");
  // The legacy binary lockfile still selects bun.
  assert.equal(pmNameOf(repoWith({ "bun.lockb": "" })), "bun");
});

test("detect: packageManager field (corepack standard) wins over lockfiles", () => {
  const repo = repoWith({
    "package.json": `{"packageManager":"pnpm@9.0.0"}`,
    "package-lock.json": "{}", // stale leftover — the field is authoritative
  });
  assert.equal(pmNameOf(repo), "pnpm");
  assert.equal(pmNameOf(repoWith({ "package.json": `{"packageManager":"bun@1.3.14"}` })), "bun");
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

test("detect: yarn is recognized but refused as unsupported", () => {
  for (const files of [
    { "yarn.lock": "" },
    { "package.json": `{"packageManager":"yarn@4.0.0"}` },
  ]) {
    const detected = detectPackageManager(repoWith(files));
    assert.equal(detected.ok, false);
    if (!detected.ok) {
      assert.equal(detected.status, "unsupported-package-manager");
      assert.match(detected.summary, /npm, pnpm, and bun/);
    }
  }
});

test("detect: multiple package managers' lockfiles without a field is a refusal, not a guess", () => {
  // Running the wrong PM's install/verify would misattribute failures.
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

  assert.equal(
    bunToolchain.installCommand(repoWith({ "bun.lock": "{}" })),
    "bun install --frozen-lockfile",
  );
  assert.equal(
    bunToolchain.installCommand(repoWith({ "bun.lockb": "" })),
    "bun install --frozen-lockfile",
  );
  assert.equal(bunToolchain.installCommand(repoWith({})), null);
});

test("toolchains: per-PM commands, lockfile sets, and extra manifests", () => {
  assert.equal(npmToolchain.runScript("test"), "npm run test");
  assert.equal(pnpmToolchain.runScript("test"), "pnpm run test");
  assert.equal(bunToolchain.runScript("test"), "bun run test");
  // lockfiles drive detection, the dep diff, and error messages.
  assert.ok(npmToolchain.lockfiles.includes("package-lock.json"));
  assert.ok(pnpmToolchain.lockfiles.includes("pnpm-lock.yaml"));
  assert.ok(!pnpmToolchain.lockfiles.includes("package-lock.json"));
  // Both bun lockfile forms may coexist; both must be recognized.
  assert.ok(bunToolchain.lockfiles.includes("bun.lock"));
  assert.ok(bunToolchain.lockfiles.includes("bun.lockb"));
  // pnpm alone carries dependency state outside package.json: a catalog-pinned
  // update moves through pnpm-workspace.yaml, so the manifest diff must see it.
  assert.deepEqual(npmToolchain.extraManifestFiles, []);
  assert.deepEqual(pnpmToolchain.extraManifestFiles, ["pnpm-workspace.yaml"]);
  assert.deepEqual(bunToolchain.extraManifestFiles, []);
});

test("ALL_PM_LOCKFILES is the union of every supported PM's lockfiles", () => {
  // scope.ts's fixer gate and the dependency-state classifier deny/claim these
  // regardless of the detected PM, so the union must stay complete.
  for (const pm of [npmToolchain, pnpmToolchain, bunToolchain]) {
    for (const lockfile of pm.lockfiles) {
      assert.ok(ALL_PM_LOCKFILES.includes(lockfile), `${lockfile} missing from union`);
    }
  }
  assert.equal(ALL_PM_LOCKFILES.length, 5);
});

test("UNSUPPORTED_PM_LOCKFILES names the lockfiles the fixer gate must still deny", () => {
  // A fixer-CREATED yarn.lock/nub.lock would smuggle resolutions the next
  // `yarn install` treats as real, so these are denied without being detected.
  assert.deepEqual(UNSUPPORTED_PM_LOCKFILES.toSorted(), ["nub.lock", "yarn.lock"]);
  for (const lockfile of UNSUPPORTED_PM_LOCKFILES) {
    assert.ok(!ALL_PM_LOCKFILES.includes(lockfile), `${lockfile} must not join detection`);
  }
});
