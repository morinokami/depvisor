import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentBranch, revParse } from "../src/core/git.ts";
import { RefGuard } from "../src/core/ref-guard.ts";

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-ref-guard-"));
  execSync("git init -q -b main", { cwd: repo });
  writeFileSync(join(repo, "file.txt"), "base\n");
  execSync("git add -A", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });
  return repo;
}

function commit(repo: string, message: string): string {
  execSync("git add -A", { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], {
    cwd: repo,
  });
  return revParse(repo, "HEAD");
}

test("RefGuard accepts deliberate trusted branch writes after expectBranch", () => {
  const repo = tempRepo();
  const guard = RefGuard.capture(repo);
  execSync("git checkout -qb depvisor/test", { cwd: repo });
  const sha = revParse(repo, "HEAD");
  guard.expectBranch("depvisor/test", sha);

  assert.equal(guard.intactAt(sha, "depvisor/test"), null);
});

test("RefGuard restores moved, created, and deleted refs", () => {
  const repo = tempRepo();
  execSync("git branch keep", { cwd: repo });
  const trusted = revParse(repo, "HEAD");
  const guard = RefGuard.capture(repo);

  writeFileSync(join(repo, "file.txt"), "hostile\n");
  const hostile = commit(repo, "hostile");
  execSync(`git branch attacker ${hostile}`, { cwd: repo });
  execSync("git branch -D keep", { cwd: repo });

  const drift = guard.intactAt(trusted, "main");
  assert.deepEqual(drift?.refs.sort(), [
    "refs/heads/attacker",
    "refs/heads/keep",
    "refs/heads/main",
  ]);
  assert.equal(currentBranch(repo), "main");
  assert.equal(revParse(repo, "HEAD"), trusted);
  assert.equal(execSync("git branch --list attacker", { cwd: repo, encoding: "utf8" }).trim(), "");
  assert.equal(revParse(repo, "keep"), trusted);
});

test("RefGuard detects a HEAD-only move and restores the requested checkout", () => {
  const repo = tempRepo();
  const trusted = revParse(repo, "HEAD");
  execSync("git branch depvisor/test", { cwd: repo });
  const guard = RefGuard.capture(repo);

  execSync("git checkout --detach -q", { cwd: repo });
  writeFileSync(join(repo, "file.txt"), "detached\n");
  commit(repo, "detached hostile");

  const drift = guard.intactAt(trusted, "depvisor/test");
  assert.deepEqual(drift, { refs: [] });
  assert.equal(currentBranch(repo), "depvisor/test");
  assert.equal(revParse(repo, "HEAD"), trusted);
});

test("RefGuard.restore supports a quiet policy-owned rollback", () => {
  const repo = tempRepo();
  const trusted = revParse(repo, "HEAD");
  const guard = RefGuard.capture(repo);
  execSync("git branch attacker", { cwd: repo });
  writeFileSync(join(repo, "untracked.txt"), "leftover\n");

  guard.restore("main");
  assert.equal(revParse(repo, "HEAD"), trusted);
  assert.equal(execSync("git branch --list attacker", { cwd: repo, encoding: "utf8" }).trim(), "");
  assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim(), "");
});
