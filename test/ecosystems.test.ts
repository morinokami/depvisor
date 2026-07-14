import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeUpdate } from "../src/ecosystems/index.ts";
import { goModAdapter } from "../src/ecosystems/gomod.ts";
import { npmAdapter } from "../src/ecosystems/npm.ts";

const ROOT = join(process.cwd(), "fixtures/pr-pairs");

function snapshot(pair: string, changedPaths: string[]) {
  const read = (side: "base" | "head", path: string) =>
    readFileSync(join(ROOT, pair, side, path), "utf8");
  return {
    changedPaths,
    readBase: (path: string) => read("base", path),
    readHead: (path: string) => read("head", path),
  };
}

test("JavaScript adapter extracts updater-owned state without running npm", () => {
  const result = npmAdapter.analyze(snapshot("javascript", ["package.json", "package-lock.json"]));
  assert.equal(result.complete, true);
  assert.equal(result.changes[0]?.package, "lru-cache");
  assert.equal(result.changes[0]?.from, "^10.4.3");
  assert.equal(result.changes[0]?.capability, "repair-safe");
});

test("Go modules is a non-JS repair-safe adapter", () => {
  const result = goModAdapter.analyze(snapshot("go", ["go.mod", "go.sum"]));
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.changes.map((change) => [change.ecosystem, change.package, change.from, change.to]),
    [["go", "golang.org/x/text", "v0.22.0", "v0.28.0"]],
  );
  assert.equal(result.changes[0]?.capability, "repair-safe");
});

test("lockfile-only changes fail closed for repair", () => {
  const result = npmAdapter.analyze(snapshot("javascript", ["package-lock.json"]));
  assert.equal(result.complete, false);
  assert.deepEqual(result.changes, []);
});

test("ambiguous JavaScript lockfiles fail closed for repair", () => {
  const result = npmAdapter.analyze(
    snapshot("javascript", ["package.json", "package-lock.json", "pnpm-lock.yaml"]),
  );
  assert.equal(result.complete, false);
  assert.match(result.reason ?? "", /Ambiguous/);
});

test("the ecosystem-neutral core combines JavaScript and Go without selecting versions", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-multi-ecosystem-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  try {
    git("init", "--initial-branch=main");
    cpSync(join(ROOT, "javascript", "base", "package.json"), join(repo, "package.json"));
    cpSync(join(ROOT, "javascript", "base", "package-lock.json"), join(repo, "package-lock.json"));
    cpSync(join(ROOT, "go", "base", "go.mod"), join(repo, "go.mod"));
    cpSync(join(ROOT, "go", "base", "go.sum"), join(repo, "go.sum"));
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
    const base = git("rev-parse", "HEAD");

    cpSync(join(ROOT, "javascript", "head", "package.json"), join(repo, "package.json"));
    cpSync(join(ROOT, "javascript", "head", "package-lock.json"), join(repo, "package-lock.json"));
    cpSync(join(ROOT, "go", "head", "go.mod"), join(repo, "go.mod"));
    cpSync(join(ROOT, "go", "head", "go.sum"), join(repo, "go.sum"));
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "head");
    const head = git("rev-parse", "HEAD");

    const normalized = normalizeUpdate(repo, base, head);
    assert.equal(normalized.repairSafe, true);
    assert.deepEqual(normalized.changes.map((change) => change.ecosystem).toSorted(), [
      "go",
      "javascript",
    ]);

    writeFileSync(join(repo, "generated.ts"), "export {};\n");
    git("add", "generated.ts");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "extra");
    const unclaimedHead = git("rev-parse", "HEAD");
    const unclaimed = normalizeUpdate(repo, base, unclaimedHead);
    assert.equal(unclaimed.repairSafe, false);
    assert.match(unclaimed.genericReasons.join(" "), /generated\.ts/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
