import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPersistedCredentials,
  persistedCredentialsSummary,
} from "../src/core/credentials.ts";

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-cred-"));
  execSync("git init -q", { cwd: repo });
  return repo;
}

test("a fresh checkout has no findings", () => {
  assert.deepEqual(detectPersistedCredentials(tempRepo()), []);
});

test("flags the actions/checkout extraheader without leaking the token", () => {
  const repo = tempRepo();
  // Exactly what persist-credentials: true writes.
  execSync('git config "http.https://github.com/.extraheader" "AUTHORIZATION: basic c2VjcmV0"', {
    cwd: repo,
  });
  const findings = detectPersistedCredentials(repo);
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? "", /extraheader/);
  // Finding and summary name the key only — the value IS the token.
  const summary = persistedCredentialsSummary(findings);
  assert.ok(!findings[0]?.includes("c2VjcmV0"));
  assert.ok(!summary.includes("c2VjcmV0"));
  assert.ok(summary.includes("persist-credentials: false"));
});

test("flags the unscoped http.extraHeader too", () => {
  const repo = tempRepo();
  // No URL subsection — applies to every HTTP request, same token exposure.
  execSync('git config http.extraHeader "AUTHORIZATION: basic c2VjcmV0"', { cwd: repo });
  const findings = detectPersistedCredentials(repo);
  assert.equal(findings.length, 1);
  assert.match(findings[0] ?? "", /^http\.extraheader /);
  assert.ok(!findings[0]?.includes("c2VjcmV0"));
});

test("a non-authorization extraheader is not a credential", () => {
  const repo = tempRepo();
  execSync('git config "http.https://github.com/.extraheader" "X-Trace-Id: 1"', { cwd: repo });
  assert.deepEqual(detectPersistedCredentials(repo), []);
});

test("flags tokens embedded in remote URLs, in both common shapes", () => {
  const repo = tempRepo();
  execSync("git remote add origin https://x-access-token:ghs_secret@github.com/o/r.git", {
    cwd: repo,
  });
  execSync("git remote add mirror https://ghs_bare_token@github.com/o/r.git", { cwd: repo });
  const findings = detectPersistedCredentials(repo);
  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.ok(!f.includes("ghs_secret") && !f.includes("ghs_bare_token"));
  }
});

test("clean https and ssh remotes are not flagged", () => {
  const repo = tempRepo();
  execSync("git remote add origin https://github.com/o/r.git", { cwd: repo });
  execSync("git remote add scp git@github.com:o/r.git", { cwd: repo });
  execSync("git remote add ssh ssh://git@github.com/o/r.git", { cwd: repo });
  assert.deepEqual(detectPersistedCredentials(repo), []);
});

test("flags a persisted SSH key (core.sshCommand) and repo-local credential helpers", () => {
  const repo = tempRepo();
  execSync('git config core.sshCommand "ssh -i /tmp/persisted-key"', { cwd: repo });
  execSync("git config credential.helper store", { cwd: repo });
  execSync('git config "credential.https://github.com.helper" store', { cwd: repo });
  const findings = detectPersistedCredentials(repo);
  assert.equal(findings.length, 3);
});

test("only repo-local config counts — a global credential helper is fine", () => {
  const repo = tempRepo();
  const globalCfg = join(mkdtempSync(join(tmpdir(), "depvisor-cred-global-")), "gitconfig");
  writeFileSync(globalCfg, "[credential]\n\thelper = osxkeychain\n");
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    assert.deepEqual(detectPersistedCredentials(repo), []);
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  }
});
