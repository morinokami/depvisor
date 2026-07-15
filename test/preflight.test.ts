import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmToolchain } from "../src/core/pm.ts";
import { preflight, resolveResetCommand, type PreflightOptions } from "../src/core/preflight.ts";

function git(repo: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: "utf8" }).trim();
}

function commit(repo: string, message: string): void {
  git(repo, "add -A");
  git(repo, `-c user.email=t@t -c user.name=t commit -qm "${message}" --allow-empty`);
}

function tempRepo(files: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-preflight-"));
  git(repo, "init -q -b main");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content);
  }
  commit(repo, "init");
  return repo;
}

const HEAD_BRANCH = "dependabot/npm_and_yarn/lru-cache-11.0.0";

/**
 * The shape a real run sees: a green base on main (npm lockfile, build+test
 * scripts) plus a checked-out updater head branch one commit ahead of it.
 */
function greenRepo(): string {
  const repo = tempRepo({
    "package.json": JSON.stringify({ scripts: { build: "true", test: "true" } }),
    "package-lock.json": "{}",
  });
  git(repo, `checkout -qb ${HEAD_BRANCH}`);
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ bumped: true }));
  commit(repo, "deps: bump lru-cache");
  return repo;
}

const MAIN_OPTS: PreflightOptions = { baseRef: "main", headRef: undefined, verifyCommands: "" };

function failure(
  repo: string,
  opts: PreflightOptions = MAIN_OPTS,
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

test("preflight: a dirty tree is refused, not repaired on top of", () => {
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

test("preflight: a detached HEAD needs the head_ref input to name the PR branch", () => {
  const repo = greenRepo();
  const headSha = git(repo, "rev-parse HEAD");
  git(repo, "checkout -q --detach");
  // The repair is published to the head branch, so an anonymous checkout with
  // nothing naming that branch cannot proceed.
  assert.equal(failure(repo).status, "bad-head-ref");

  // The head_ref input names the branch when the checkout cannot.
  const res = preflight(repo, { baseRef: "main", headRef: HEAD_BRANCH, verifyCommands: "" });
  assert.equal(res.ok, true, JSON.stringify(res));
  if (!res.ok) throw new Error("unreachable");
  assert.equal(res.headRef, HEAD_BRANCH);
  assert.equal(res.headSha, headSha);
});

test("preflight: a base that was never fetched is refused with fetch guidance", () => {
  const repo = greenRepo();
  const res = failure(repo, { baseRef: "not-fetched", headRef: undefined, verifyCommands: "" });
  assert.equal(res.status, "missing-base-ref");
  assert.match(res.summary, /not-fetched/);
  assert.match(res.summary, /fetch-depth: 0/);
});

test("preflight: unrelated histories have no merge base to attribute against", () => {
  const repo = greenRepo();
  git(repo, "checkout -q --orphan lonely");
  commit(repo, "orphan root");
  const res = failure(repo);
  assert.equal(res.status, "missing-base-ref");
  assert.match(res.summary, /No merge base/);
});

test("preflight: a CI checkout resolves the base through refs/remotes/origin/", () => {
  // actions/checkout of the head branch with fetch-depth 0 has the base only
  // as a remote-tracking ref, never a local branch.
  const repo = greenRepo();
  const mainSha = git(repo, "rev-parse main");
  git(repo, `update-ref refs/remotes/origin/develop ${mainSha}`);
  const res = preflight(repo, { baseRef: "develop", headRef: undefined, verifyCommands: "" });
  assert.equal(res.ok, true, JSON.stringify(res));
  if (!res.ok) throw new Error("unreachable");
  assert.equal(res.mergeBaseSha, mainSha);
});

test("preflight: no detectable verify scripts means no repair (typecheck alone does not count)", () => {
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

test("preflight ok: pins the PM, names the head, and anchors the merge base at main's tip", () => {
  const repo = greenRepo();
  const mainSha = git(repo, "rev-parse main");
  const headSha = git(repo, "rev-parse HEAD");
  const res = preflight(repo, MAIN_OPTS);
  assert.equal(res.ok, true, JSON.stringify(res));
  if (!res.ok) throw new Error("unreachable");
  // Unset head_ref falls back to the checked-out branch.
  assert.equal(res.headRef, HEAD_BRANCH);
  assert.equal(res.headSha, headSha);
  assert.notEqual(res.headSha, mainSha); // the head really is ahead of the base
  assert.equal(res.mergeBaseSha, mainSha);
  assert.equal(res.pm.name, "npm");
  // Auto-detection order is build → lint → test; lint is not defined here.
  assert.deepEqual(res.verifySteps, [
    { name: "build", run: "npm run build" },
    { name: "test", run: "npm run test" },
  ]);
});

test("preflight ok: explicit verify_commands replace auto-detection entirely", () => {
  const repo = greenRepo();
  const res = preflight(repo, {
    baseRef: "main",
    headRef: undefined,
    verifyCommands: "make check\nmake e2e\n",
  });
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
