import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedPaths, revParse } from "../src/core/git.ts";
import { runCandidateVerification, runConfirmedVerification } from "../src/core/verify.ts";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

function repository(): { repo: string; sha: string; dispose(): void } {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-verify-test-"));
  git(repo, "init", "--initial-branch=main");
  writeFileSync(join(repo, "source.ts"), "export const value = 1;\n");
  git(repo, "add", "source.ts");
  git(
    repo,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  );
  return { repo, sha: revParse(repo, "HEAD"), dispose: () => rmSync(repo, { recursive: true }) };
}

test("baseline/head verification distinguishes green, stable red, and flake", () => {
  const fixture = repository();
  const marker = join(tmpdir(), `depvisor-verify-marker-${process.pid}-${Date.now()}`);
  try {
    assert.equal(
      runConfirmedVerification(
        fixture.repo,
        fixture.sha,
        "baseline",
        [],
        [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
      ).state,
      "green",
    );
    const stable = runConfirmedVerification(
      fixture.repo,
      fixture.sha,
      "head",
      [],
      [`${JSON.stringify(process.execPath)} -e "process.exit(7)"`],
    );
    assert.equal(stable.state, "stable-red");
    assert.equal(stable.results.length, 2);

    const script =
      `const fs=require('node:fs');const p=${JSON.stringify(marker)};` +
      "if(fs.existsSync(p))process.exit(0);fs.writeFileSync(p,'x');process.exit(1)";
    assert.equal(
      runConfirmedVerification(
        fixture.repo,
        fixture.sha,
        "head",
        [],
        [`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`],
      ).state,
      "unstable",
    );
  } finally {
    rmSync(marker, { force: true });
    fixture.dispose();
  }
});

test("verification fails closed on worktree and ref mutation", () => {
  const fixture = repository();
  try {
    const dirtyScript = "require('node:fs').writeFileSync('generated.ts','bad')";
    assert.equal(
      runConfirmedVerification(
        fixture.repo,
        fixture.sha,
        "baseline",
        [],
        [`${JSON.stringify(process.execPath)} -e ${JSON.stringify(dirtyScript)}`],
      ).state,
      "dirty",
    );

    const refMutation = "git update-ref refs/heads/injected HEAD";
    assert.equal(
      runConfirmedVerification(fixture.repo, fixture.sha, "head", [], [refMutation]).state,
      "unexpected-commits",
    );
  } finally {
    fixture.dispose();
  }
});

test("candidate verification seals the exact source patch", () => {
  const fixture = repository();
  try {
    writeFileSync(join(fixture.repo, "source.ts"), "export const value = 2;\n");
    assert.equal(
      runCandidateVerification(
        fixture.repo,
        fixture.sha,
        [],
        [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
      ).state,
      "green",
    );
    const mutation = "require('node:fs').appendFileSync('source.ts','// changed\\n')";
    assert.equal(
      runCandidateVerification(
        fixture.repo,
        fixture.sha,
        [],
        [`${JSON.stringify(process.execPath)} -e ${JSON.stringify(mutation)}`],
      ).state,
      "dirty",
    );
  } finally {
    fixture.dispose();
  }
});

test("git path collection preserves both sides of a rename", () => {
  const fixture = repository();
  try {
    git(fixture.repo, "mv", "source.ts", "renamed.ts");
    assert.deepEqual(changedPaths(fixture.repo), ["renamed.ts", "source.ts"]);
  } finally {
    fixture.dispose();
  }
});
