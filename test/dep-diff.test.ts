import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  classifyPrCommits,
  classifyUpdate,
  declaredDependencies,
  diffDependencies,
  lockfileVersions,
} from "../src/core/dep-diff.ts";
import { AGENT_EMAIL } from "../src/core/git.ts";
import { bunToolchain, npmToolchain, pnpmToolchain } from "../src/core/pm.ts";

const DEPENDABOT_EMAIL = "49699333+dependabot[bot]@users.noreply.github.com";

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-depdiff-"));
  execSync("git init -q -b main", { cwd: repo });
  return repo;
}

/** Write files and commit them under a chosen committer identity (the ownership
 * signal classifyPrCommits keys on). Returns the commit sha. */
function commit(repo: string, files: Record<string, string>, email = "dev@example.com"): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execSync("git add -A", { cwd: repo });
  execSync("git commit -q -m change", {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: email,
    },
  });
  return execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
}

const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}): string =>
  JSON.stringify({ name: "app", dependencies: deps, devDependencies: dev });

/** A minimal lockfileVersion-3 package-lock.json resolving the given versions. */
function npmLockV3(versions: Record<string, string>): string {
  return JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    packages: {
      "": { name: "app" },
      ...Object.fromEntries(
        Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }]),
      ),
    },
  });
}

const pnpmLockV9 = (version: string): string =>
  `lockfileVersion: '9.0'\npackages:\n  lru-cache@${version}:\n    resolution: {integrity: sha512-x}\n`;

// bun.lock is JSONC: trailing commas are part of the format bun writes.
const bunLock = (version: string): string =>
  `{\n  "lockfileVersion": 1,\n  "packages": {\n    "lru-cache": ["lru-cache@${version}", "", {}, "sha512-x"],\n  },\n}\n`;

test("classifyUpdate classifies from the x.y.z core, range specifiers included", () => {
  assert.equal(classifyUpdate("7.18.3", "11.2.1"), "major");
  assert.equal(classifyUpdate("1.2.3", "1.3.0"), "minor");
  assert.equal(classifyUpdate("1.2.3", "1.2.4"), "patch");
  // range specifiers parse via their embedded x.y.z core
  assert.equal(classifyUpdate("^1.2.3", "^1.3.0"), "minor");
  assert.equal(classifyUpdate("^7.0.0", "^11.0.0"), "major");
  // a downgrade, no movement, and an unparseable side are all "unknown"
  assert.equal(classifyUpdate("2.0.0", "1.0.0"), "unknown");
  assert.equal(classifyUpdate("1.0.0", "1.0.0"), "unknown");
  assert.equal(classifyUpdate("workspace:*", "1.0.0"), "unknown");
});

test("classifyPrCommits separates updater, depvisor, and foreign commits", () => {
  const repo = tempRepo();
  const base = commit(repo, {
    "package.json": pkg({ "lru-cache": "^7.0.0" }),
    "package-lock.json": npmLockV3({ "lru-cache": "7.18.3" }),
    "src/index.ts": "export {};\n",
  });

  // a dependency-state-only commit under any email is the updater's work
  commit(
    repo,
    {
      "package.json": pkg({ "lru-cache": "^11.0.0" }),
      "package-lock.json": npmLockV3({ "lru-cache": "11.2.1" }),
    },
    DEPENDABOT_EMAIL,
  );
  assert.deepEqual(classifyPrCommits(repo, base, "HEAD"), {
    ok: true,
    ownCommits: 0,
    updaterCommits: 1,
  });

  // depvisor's committer sentinel may touch source: a prior run's repair commit
  commit(repo, { "src/index.ts": "export const repaired = 1;\n" }, AGENT_EMAIL);
  assert.deepEqual(classifyPrCommits(repo, base, "HEAD"), {
    ok: true,
    ownCommits: 1,
    updaterCommits: 1,
  });

  // any other commit touching non-dependency paths makes the PR foreign,
  // with the offending paths named (sorted)
  const foreignSha = commit(
    repo,
    { "README.md": "hi\n", "src/extra.ts": "export {};\n" },
    "human@example.com",
  );
  assert.deepEqual(classifyPrCommits(repo, base, "HEAD"), {
    ok: false,
    foreign: [{ sha: foreignSha, paths: ["README.md", "src/extra.ts"] }],
  });
});

test("npm: lockfile-resolved diff names the direct change and files transitives separately", () => {
  const repo = tempRepo();
  const base = commit(repo, {
    "package.json": pkg({ "lru-cache": "^7.0.0" }),
    "package-lock.json": npmLockV3({ "lru-cache": "7.18.3", yallist: "4.0.0" }),
  });
  const head = commit(repo, {
    "package.json": pkg({ "lru-cache": "^11.0.0" }),
    "package-lock.json": npmLockV3({ "lru-cache": "11.2.1", yallist: "5.0.0" }),
  });
  const diff = diffDependencies(repo, base, head, npmToolchain);
  assert.equal(diff.lockfileResolved, true);
  assert.deepEqual(diff.direct, [
    {
      name: "lru-cache",
      from: "7.18.3",
      to: "11.2.1",
      kind: "prod",
      updateType: "major",
      locations: [""],
    },
  ]);
  // yallist moved in the lockfile but no manifest declares it
  assert.deepEqual(diff.transitives, ["yallist"]);
  assert.deepEqual(diff.changedFiles, ["package-lock.json", "package.json"]);
});

test("npm: without a lockfile, from/to fall back to the manifest specifiers", () => {
  const repo = tempRepo();
  const base = commit(repo, { "package.json": pkg({ "lru-cache": "^7.0.0" }) });
  const head = commit(repo, { "package.json": pkg({ "lru-cache": "^11.0.0" }) });
  const diff = diffDependencies(repo, base, head, npmToolchain);
  assert.equal(diff.lockfileResolved, false);
  assert.deepEqual(diff.direct, [
    {
      name: "lru-cache",
      from: "^7.0.0",
      to: "^11.0.0",
      kind: "prod",
      updateType: "major",
      locations: [""],
    },
  ]);
  assert.deepEqual(diff.transitives, []);
});

test("npm: a lockfile-only in-range update surfaces with resolved versions", () => {
  const repo = tempRepo();
  const base = commit(repo, {
    "package.json": pkg({ "lru-cache": "^7.0.0" }),
    "package-lock.json": npmLockV3({ "lru-cache": "7.18.2" }),
  });
  // Dependabot's in-range bump touches only the lockfile
  const head = commit(repo, { "package-lock.json": npmLockV3({ "lru-cache": "7.18.3" }) });
  const diff = diffDependencies(repo, base, head, npmToolchain);
  assert.equal(diff.lockfileResolved, true);
  assert.deepEqual(diff.direct, [
    {
      name: "lru-cache",
      from: "7.18.2",
      to: "7.18.3",
      kind: "prod",
      updateType: "patch",
      locations: [""],
    },
  ]);
  assert.deepEqual(diff.changedFiles, ["package-lock.json"]);
});

test("npm: lockfileVersion 1 nested dependencies parse too", () => {
  const repo = tempRepo();
  const lock = JSON.stringify({
    name: "app",
    lockfileVersion: 1,
    dependencies: {
      "lru-cache": { version: "7.18.3", dependencies: { yallist: { version: "4.0.0" } } },
    },
  });
  const ref = commit(repo, { "package-lock.json": lock });
  const versions = lockfileVersions(repo, ref, npmToolchain);
  assert.deepEqual(versions?.get("lru-cache"), new Set(["7.18.3"]));
  assert.deepEqual(versions?.get("yallist"), new Set(["4.0.0"]));
});

test("pnpm: v9 lockfile keys resolve the diff", () => {
  const repo = tempRepo();
  const base = commit(repo, {
    "package.json": pkg({ "lru-cache": "^7.0.0" }),
    "pnpm-lock.yaml": pnpmLockV9("7.18.3"),
  });
  const head = commit(repo, {
    "package.json": pkg({ "lru-cache": "^11.0.0" }),
    "pnpm-lock.yaml": pnpmLockV9("11.2.1"),
  });
  const diff = diffDependencies(repo, base, head, pnpmToolchain);
  assert.equal(diff.lockfileResolved, true);
  assert.deepEqual(diff.direct, [
    {
      name: "lru-cache",
      from: "7.18.3",
      to: "11.2.1",
      kind: "prod",
      updateType: "major",
      locations: [""],
    },
  ]);
});

test("pnpm: v6-style keys parse with the leading slash and peer suffix stripped", () => {
  const repo = tempRepo();
  const ref = commit(repo, {
    "pnpm-lock.yaml":
      "lockfileVersion: '6.0'\npackages:\n  /lru-cache@7.18.3(patched@1.0.0):\n    resolution: {integrity: sha512-x}\n",
  });
  const versions = lockfileVersions(repo, ref, pnpmToolchain);
  assert.deepEqual(versions?.get("lru-cache"), new Set(["7.18.3"]));
});

test("pnpm: catalog specifiers resolve through pnpm-workspace.yaml at the same ref", () => {
  const repo = tempRepo();
  const ref = commit(repo, {
    "package.json": JSON.stringify({
      name: "root",
      dependencies: { "lru-cache": "catalog:", typescript: "catalog:tools" },
    }),
    "pnpm-workspace.yaml":
      "packages:\n  - packages/*\ncatalog:\n  lru-cache: 7.18.3\ncatalogs:\n  tools:\n    typescript: 5.5.4\n",
  });
  const decls = declaredDependencies(repo, ref, pnpmToolchain);
  assert.equal(decls.get("lru-cache")?.spec, "7.18.3");
  assert.equal(decls.get("typescript")?.spec, "5.5.4");
  // catalog resolution is a pnpm-workspace.yaml feature: other PMs keep the raw spec
  assert.equal(declaredDependencies(repo, ref, npmToolchain).get("lru-cache")?.spec, "catalog:");
});

test("bun: the JSONC bun.lock (trailing commas) resolves the diff", () => {
  const repo = tempRepo();
  const base = commit(repo, {
    "package.json": pkg({ "lru-cache": "^7.0.0" }),
    "bun.lock": bunLock("7.18.3"),
  });
  const head = commit(repo, {
    "package.json": pkg({ "lru-cache": "^11.0.0" }),
    "bun.lock": bunLock("11.2.1"),
  });
  const diff = diffDependencies(repo, base, head, bunToolchain);
  assert.equal(diff.lockfileResolved, true);
  assert.deepEqual(diff.direct, [
    {
      name: "lru-cache",
      from: "7.18.3",
      to: "11.2.1",
      kind: "prod",
      updateType: "major",
      locations: [""],
    },
  ]);
});

test("declaredDependencies merges workspaces: prod wins over dev, locations sorted", () => {
  const repo = tempRepo();
  const ref = commit(repo, {
    "package.json": JSON.stringify({
      name: "root",
      devDependencies: { "lru-cache": "^7.0.0", typescript: "^5.0.0" },
    }),
    "packages/core/package.json": JSON.stringify({
      name: "core",
      dependencies: { "lru-cache": "^7.0.0" },
    }),
  });
  const decls = declaredDependencies(repo, ref, npmToolchain);
  // declared as dev at the root but prod in a workspace → prod wins
  assert.equal(decls.get("lru-cache")?.kind, "prod");
  assert.deepEqual(decls.get("lru-cache")?.locations, ["", "packages/core"]);
  assert.equal(decls.get("typescript")?.kind, "dev");
  assert.deepEqual(decls.get("typescript")?.locations, [""]);
});

test("dev vs prod kind and workspace locations flow through the manifest diff", () => {
  const repo = tempRepo();
  const base = commit(repo, {
    "package.json": JSON.stringify({ name: "root", devDependencies: { typescript: "^5.0.0" } }),
    "packages/core/package.json": JSON.stringify({
      name: "core",
      dependencies: { "lru-cache": "^7.0.0" },
    }),
  });
  const head = commit(repo, {
    "package.json": JSON.stringify({ name: "root", devDependencies: { typescript: "^5.5.0" } }),
    "packages/core/package.json": JSON.stringify({
      name: "core",
      dependencies: { "lru-cache": "^11.0.0" },
    }),
  });
  const diff = diffDependencies(repo, base, head, npmToolchain);
  assert.equal(diff.lockfileResolved, false);
  assert.deepEqual(diff.direct, [
    {
      name: "lru-cache",
      from: "^7.0.0",
      to: "^11.0.0",
      kind: "prod",
      updateType: "major",
      locations: ["packages/core"],
    },
    {
      name: "typescript",
      from: "^5.0.0",
      to: "^5.5.0",
      kind: "dev",
      updateType: "minor",
      locations: [""],
    },
  ]);
});
