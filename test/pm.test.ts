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

// updatePlan builds the deterministic per-PM, per-workspace update as argv
// arrays the executor (bump.ts) runs directly, so the installed version and the
// branch/PR identity are fixed by code. These assert exact argv parity per PM.

test("npm updatePlan mirrors the instruction argv (root deps, -D for dev, no catalogs)", () => {
  const plan = npmToolchain.updatePlan(
    [
      cand({ name: "left-pad", latest: "1.3.0" }),
      cand({ name: "eslint", latest: "9.0.0", kind: "dev" }),
    ],
    repoWith({}), // repoPath is unused by npm
  );
  assert.deepEqual(plan.catalogEdits, []);
  assert.deepEqual(plan.commands, [
    ["npm", "install", "left-pad@1.3.0"],
    ["npm", "install", "-D", "eslint@9.0.0"],
  ]);
  assert.equal(plan.pinExact, false);
});

test("npm updatePlan scopes -w to declaring workspaces, root gets its own command", () => {
  const plan = npmToolchain.updatePlan(
    [
      cand({ name: "left-pad", latest: "1.3.0", locations: ["packages/a", "packages/b"] }),
      cand({ name: "ms", latest: "2.1.3", locations: ["", "packages/a"] }),
    ],
    repoWith({}),
  );
  assert.deepEqual(plan.commands, [
    ["npm", "install", "left-pad@1.3.0", "-w", "packages/a", "-w", "packages/b"],
    ["npm", "install", "ms@2.1.3"],
    ["npm", "install", "ms@2.1.3", "-w", "packages/a"],
  ]);
});

test("npm updatePlan records pinExact but leaves the argv unchanged", () => {
  const candidates = [cand({ name: "left-pad", latest: "1.3.0" })];
  const repo = repoWith({});
  const pinned = npmToolchain.updatePlan(candidates, repo, { pinExact: true });
  assert.equal(pinned.pinExact, true);
  assert.deepEqual(pinned.commands, npmToolchain.updatePlan(candidates, repo).commands);
});

test("pnpm updatePlan uses a single recursive command when no member is catalog-pinned", () => {
  const repo = repoWith({}); // no pnpm-workspace.yaml → no catalog names
  const plan = pnpmToolchain.updatePlan(
    [
      cand({ name: "left-pad", latest: "1.3.0", locations: ["packages/a"] }),
      cand({ name: "isarray", latest: "2.0.5", kind: "dev", locations: ["packages/a"] }),
    ],
    repo,
  );
  assert.deepEqual(plan.catalogEdits, []);
  assert.deepEqual(plan.commands, [["pnpm", "-r", "update", "left-pad@1.3.0", "isarray@2.0.5"]]);
});

test("pnpm updatePlan routes catalog-pinned members to catalogEdits, not the command", () => {
  const repo = repoWith({
    "pnpm-workspace.yaml":
      "packages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0\ncatalogs:\n  react:\n    react: ^18.0.0\n",
  });
  const plan = pnpmToolchain.updatePlan(
    [
      cand({ name: "semver", latest: "7.7.3" }), // top-level catalog
      cand({ name: "react", latest: "19.0.0" }), // a named catalog
      cand({ name: "left-pad", latest: "1.3.0" }), // plain
    ],
    repo,
  );
  // Catalog members become edits (target = latest; range style is decided later,
  // in the executor); only the plain member stays in the recursive command, and
  // the refresh install is appended because catalog edits exist.
  assert.deepEqual(plan.catalogEdits, [
    { name: "semver", target: "7.7.3" },
    { name: "react", target: "19.0.0" },
  ]);
  assert.deepEqual(plan.commands, [
    ["pnpm", "-r", "update", "left-pad@1.3.0"],
    ["pnpm", "install", "--no-frozen-lockfile"],
  ]);
});

test("pnpm updatePlan emits only the refresh install when every member is catalog-pinned", () => {
  const repo = repoWith({ "pnpm-workspace.yaml": "catalog:\n  semver: ^7.3.0\n" });
  const plan = pnpmToolchain.updatePlan([cand({ name: "semver", latest: "7.7.3" })], repo);
  assert.deepEqual(plan.catalogEdits, [{ name: "semver", target: "7.7.3" }]);
  assert.deepEqual(plan.commands, [["pnpm", "install", "--no-frozen-lockfile"]]);
});

test("bun updatePlan mirrors the instruction argv (caret, --cwd, -d, no catalogs)", () => {
  const plan = bunToolchain.updatePlan(
    [
      cand({ name: "left-pad", latest: "1.3.0", locations: ["packages/a", "packages/b"] }),
      cand({ name: "isarray", latest: "2.0.5", kind: "dev", locations: ["packages/a"] }),
      cand({ name: "ms", latest: "2.1.3", locations: [""] }),
    ],
    repoWith({}),
  );
  assert.deepEqual(plan.catalogEdits, []);
  assert.deepEqual(plan.commands, [
    ["bun", "add", "--cwd", "packages/a", "left-pad@^1.3.0"],
    ["bun", "add", "--cwd", "packages/b", "left-pad@^1.3.0"],
    ["bun", "add", "--cwd", "packages/a", "-d", "isarray@^2.0.5"],
    ["bun", "add", "ms@^2.1.3"], // root → no --cwd
  ]);
});

test("bun updatePlan drops the caret under pinExact (cannot outrun a release-age clamp)", () => {
  const plan = bunToolchain.updatePlan(
    [
      cand({ name: "chalk", latest: "5.0.0" }),
      cand({ name: "@types/node", latest: "22.0.0", kind: "dev" }),
    ],
    repoWith({}),
    { pinExact: true },
  );
  assert.equal(plan.pinExact, true);
  assert.deepEqual(plan.commands, [
    ["bun", "add", "chalk@5.0.0"],
    ["bun", "add", "-d", "@types/node@22.0.0"],
  ]);
});
