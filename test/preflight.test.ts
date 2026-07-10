import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmToolchain } from "../src/core/pm.ts";
import { preflight, resolveResetCommand, type PreflightOptions } from "../src/core/preflight.ts";

function tempRepo(files: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-preflight-"));
  execSync("git init -q -b main", { cwd: repo });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content);
  }
  execSync("git add -A", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit -qm init --allow-empty", { cwd: repo });
  return repo;
}

/** A repo that passes every gate: npm lockfile, build+test scripts. */
function greenRepo(): string {
  return tempRepo({
    "package.json": JSON.stringify({ scripts: { build: "true", test: "true" } }),
    "package-lock.json": "{}",
  });
}

const NO_OPTS: PreflightOptions = { baseBranch: undefined, verifyCommands: "" };

function failure(
  repo: string,
  opts: PreflightOptions = NO_OPTS,
): { status: string; summary: string } {
  const res = preflight(repo, opts);
  assert.equal(res.ok, false, JSON.stringify(res));
  if (res.ok) throw new Error("unreachable");
  return res;
}

test("preflight: a non-repo directory is refused before anything else", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-preflight-norepo-"));
  assert.equal(failure(dir).status, "not-a-repo-root");
});

test("preflight: persisted checkout credentials fail closed before any tree read", () => {
  const repo = greenRepo();
  // Exactly what actions/checkout's persist-credentials: true writes.
  execSync('git config "http.https://github.com/.extraheader" "AUTHORIZATION: basic c2VjcmV0"', {
    cwd: repo,
  });
  const res = failure(repo);
  assert.equal(res.status, "persisted-credentials");
  // The summary names the key, never the token value.
  assert.ok(!res.summary.includes("c2VjcmV0"));
});

test("preflight: a dirty tree is refused, not built upon", () => {
  const repo = greenRepo();
  writeFileSync(join(repo, "leftover.txt"), "from a previous failed run\n");
  assert.equal(failure(repo).status, "dirty-tree");
});

test("preflight: package-manager detection failures pass through as their own status", () => {
  // Two PMs' lockfiles and no packageManager field → ambiguous, refused.
  const repo = tempRepo({
    "package.json": JSON.stringify({ scripts: { test: "true" } }),
    "package-lock.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  assert.equal(failure(repo).status, "ambiguous-package-manager");

  const yarnRepo = tempRepo({
    "package.json": JSON.stringify({ scripts: { test: "true" } }),
    "yarn.lock": "",
  });
  assert.equal(failure(yarnRepo).status, "unsupported-package-manager");
});

test("preflight: a depvisor/* base or a detached HEAD is a bad base, not an anchor", () => {
  const repo = greenRepo();
  const explicit = failure(repo, { baseBranch: "depvisor/prod/left-pad", verifyCommands: "" });
  assert.equal(explicit.status, "bad-base-branch");

  // Unset base falls back to the checked-out branch; detached HEAD resolves to
  // the literal "HEAD", which must be refused rather than used as an identity.
  execSync("git checkout -q --detach", { cwd: repo });
  assert.equal(failure(repo).status, "bad-base-branch");
});

test("preflight: an explicit base must exist in the checkout", () => {
  const repo = greenRepo();
  const res = failure(repo, { baseBranch: "not-fetched", verifyCommands: "" });
  assert.equal(res.status, "missing-base-branch");
  assert.match(res.summary, /not-fetched/);
});

test("preflight: no detectable verify scripts means no PR (typecheck alone does not count)", () => {
  // `typecheck` is deliberately not auto-detected (see verify.ts), so a repo
  // with only that script cannot be vouched for.
  const repo = tempRepo({
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc" } }),
    "package-lock.json": "{}",
  });
  const res = failure(repo);
  assert.equal(res.status, "no-verify-scripts");
  assert.match(res.summary, /verify_commands/);
});

test("preflight ok: pins the PM and derives the verify gate from the current branch", () => {
  const repo = greenRepo();
  const res = preflight(repo, NO_OPTS);
  assert.equal(res.ok, true, JSON.stringify(res));
  if (!res.ok) throw new Error("unreachable");
  assert.equal(res.base, "main");
  assert.equal(res.pm.name, "npm");
  // Auto-detection order is build → lint → test; lint is not defined here.
  assert.deepEqual(res.verifySteps, [
    { name: "build", run: "npm run build" },
    { name: "test", run: "npm run test" },
  ]);
});

test("preflight ok: explicit verify_commands replace auto-detection entirely", () => {
  const repo = greenRepo();
  const res = preflight(repo, { baseBranch: "main", verifyCommands: "make check\nmake e2e\n" });
  assert.equal(res.ok, true, JSON.stringify(res));
  if (!res.ok) throw new Error("unreachable");
  // The repo's own build/test scripts are NOT appended.
  assert.deepEqual(res.verifySteps, [
    { name: "make check", run: "make check" },
    { name: "make e2e", run: "make e2e" },
  ]);
});

test("resolveResetCommand: a custom install_command is trusted verbatim", () => {
  const repo = greenRepo();
  assert.equal(
    resolveResetCommand(npmToolchain, repo, "npm ci --ignore-scripts"),
    "npm ci --ignore-scripts",
  );
});

test("resolveResetCommand: auto/skip/unset fall back to the PM's frozen install", () => {
  const repo = greenRepo();
  for (const input of ["auto", "skip", "", "  "]) {
    assert.equal(resolveResetCommand(npmToolchain, repo, input), "npm ci");
  }
  // No committed lockfile → null (reachable only under install_command: skip).
  const bare = tempRepo({ "package.json": "{}" });
  assert.equal(resolveResetCommand(npmToolchain, bare, "auto"), null);
});
