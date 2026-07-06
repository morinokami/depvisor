import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunToolchain, detectPackageManager, npmToolchain, pnpmToolchain } from "../src/core/pm.ts";
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

  // The advertised escape hatch must itself create no lockfile.
  assert.equal(npmToolchain.noLockfileInstall, "npm install --package-lock=false");
  assert.equal(pnpmToolchain.noLockfileInstall, "pnpm install --no-lockfile");
  // bun has no escape hatch: `bun outdated` reads the committed lockfile (not the
  // installed tree), so no install flag makes a lockfile-less bun repo updatable.
  assert.equal(bunToolchain.noLockfileInstall, null);
});

test("toolchains: per-PM commands and lockfile sets", () => {
  assert.equal(npmToolchain.runScript("test"), "npm run test");
  assert.equal(pnpmToolchain.runScript("test"), "pnpm run test");
  assert.equal(bunToolchain.runScript("test"), "bun run test");
  // lockfiles drive the mechanical bump commit (with every package.json).
  assert.ok(npmToolchain.lockfiles.includes("package-lock.json"));
  assert.ok(pnpmToolchain.lockfiles.includes("pnpm-lock.yaml"));
  assert.ok(!pnpmToolchain.lockfiles.includes("package-lock.json"));
  // Both lockfile forms: whichever one `bun add` touches must be committed.
  assert.ok(bunToolchain.lockfiles.includes("bun.lock"));
  assert.ok(bunToolchain.lockfiles.includes("bun.lockb"));
});

test("outdatedArgv: workspace-aware flags", () => {
  // --long carries per-entry type + dependedByLocation; -r reports workspaces.
  assert.deepEqual(npmToolchain.outdatedArgv, ["npm", "outdated", "--json", "--long"]);
  assert.deepEqual(pnpmToolchain.outdatedArgv, ["pnpm", "outdated", "-r", "--format", "json"]);
  assert.deepEqual(bunToolchain.outdatedArgv, ["bun", "outdated", "-r"]);
});

test("npm updateInstruction: single-package uses no -w, -D marks dev deps", () => {
  const out = npmToolchain.updateInstruction([
    cand({ name: "left-pad", latest: "1.3.0" }),
    cand({ name: "eslint", latest: "9.0.0", kind: "dev" }),
  ]);
  assert.match(out, /npm install left-pad@1\.3\.0(\n|$)/);
  assert.match(out, /npm install -D eslint@9\.0\.0(\n|$)/);
  assert.doesNotMatch(out, /-w /); // no workspace flags for root-only deps
});

test("npm updateInstruction: scopes -w to declaring workspaces, root gets its own line", () => {
  const out = npmToolchain.updateInstruction([
    cand({ name: "left-pad", latest: "1.3.0", locations: ["packages/a", "packages/b"] }),
    cand({ name: "ms", latest: "2.1.3", locations: ["", "packages/a"] }),
  ]);
  assert.match(out, /npm install left-pad@1\.3\.0 -w packages\/a -w packages\/b/);
  // Declared in both root and a workspace → two commands, one scoped, one not.
  assert.match(out, /npm install ms@2\.1\.3(\n|$)/);
  assert.match(out, /npm install ms@2\.1\.3 -w packages\/a/);
});

test("pnpm updateInstruction: a single recursive command covers every workspace", () => {
  const out = pnpmToolchain.updateInstruction([
    cand({ name: "left-pad", latest: "1.3.0", locations: ["packages/a", "packages/b"] }),
    cand({ name: "isarray", latest: "2.0.5", kind: "dev", locations: ["packages/a"] }),
  ]);
  // One command, no -w, no -D: pnpm -r update preserves each dep's section.
  assert.match(out, /pnpm -r update left-pad@1\.3\.0 isarray@2\.0\.5/);
  assert.doesNotMatch(out, /-w /);
  assert.doesNotMatch(out, /-D /);
});

test("bun updateInstruction: keeps the caret, -d marks dev deps (single-package)", () => {
  const out = bunToolchain.updateInstruction([
    cand({ name: "chalk", latest: "5.0.0" }),
    cand({ name: "@types/node", latest: "22.0.0", kind: "dev" }),
  ]);
  assert.match(out, /bun add chalk@\^5\.0\.0(\n|$)/);
  assert.match(out, /bun add -d @types\/node@\^22\.0\.0(\n|$)/);
  assert.doesNotMatch(out, /--cwd/); // root-only deps take no --cwd
});

test("bun updateInstruction: pinExact drops the caret so installs cannot outrun a release-age clamp", () => {
  const candidates = [
    cand({ name: "chalk", latest: "5.0.0" }),
    cand({ name: "isarray", latest: "2.0.5", kind: "dev", locations: ["packages/a"] }),
  ];
  const out = bunToolchain.updateInstruction(candidates, { pinExact: true });
  // bun writes the specifier verbatim AND resolves ranges at install time, so
  // only the exact form is guaranteed to land on candidate.latest.
  assert.match(out, /bun add chalk@5\.0\.0(\n|$)/);
  assert.match(out, /bun add --cwd packages\/a -d isarray@2\.0\.5(\n|$)/);
  assert.doesNotMatch(out, /@\^/);

  // npm/pnpm already install the exact target; the flag changes nothing there.
  assert.equal(
    npmToolchain.updateInstruction(candidates, { pinExact: true }),
    npmToolchain.updateInstruction(candidates),
  );
  assert.equal(
    pnpmToolchain.updateInstruction(candidates, { pinExact: true }),
    pnpmToolchain.updateInstruction(candidates),
  );
});

test("bun updateInstruction: scopes --cwd to declaring workspaces, root gets its own line", () => {
  const out = bunToolchain.updateInstruction([
    cand({ name: "left-pad", latest: "1.3.0", locations: ["packages/a", "packages/b"] }),
    cand({ name: "isarray", latest: "2.0.5", kind: "dev", locations: ["packages/a"] }),
    cand({ name: "ms", latest: "2.1.3", locations: [""] }),
  ]);
  assert.match(out, /bun add --cwd packages\/a left-pad@\^1\.3\.0(\n|$)/);
  assert.match(out, /bun add --cwd packages\/b left-pad@\^1\.3\.0(\n|$)/);
  assert.match(out, /bun add --cwd packages\/a -d isarray@\^2\.0\.5(\n|$)/);
  assert.match(out, /bun add ms@\^2\.1\.3(\n|$)/); // root → no --cwd
});
