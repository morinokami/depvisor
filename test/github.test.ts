import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll } from "../src/core/git.ts";
import {
  buildSecureEnv,
  describePrCreateError,
  isNetworkRemote,
  labelReconciliation,
  openPrWithGh,
  SAFE_PATH_DIRS,
} from "../src/core/github.ts";

/** A local target repo with one human-committed base commit; no origin remote. */
function tempTargetRepo(): { repo: string; base: string; sh: (cmd: string) => string } {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-github-"));
  const sh = (cmd: string) => execSync(cmd, { cwd: repo, encoding: "utf8" });
  sh("git init -q");
  writeFileSync(join(repo, "src.ts"), "export {};\n");
  sh("git add -A && git -c user.email=human@example.com -c user.name=human commit -qm init");
  const base = sh("git rev-parse --abbrev-ref HEAD").trim();
  return { repo, base, sh };
}

test("describePrCreateError appends the repo-setting hint to the Actions-forbidden error", () => {
  const raw =
    "GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)";
  const described = describePrCreateError(raw);
  assert.ok(described.startsWith(raw));
  assert.match(described, /Allow GitHub Actions to create and approve pull requests/);
  assert.match(described, /github_token/);
});

test("describePrCreateError passes unrecognized errors through unchanged", () => {
  for (const raw of ["pull request create failed: HTTP 502", ""]) {
    assert.equal(describePrCreateError(raw), raw);
  }
});

test("push-boundary policy refusals are failed (red), not blocked (green)", () => {
  // `blocked` is reserved for the one expected policy stop — a human took over
  // the PR branch — because open-pr records it as the green `open-pr-blocked`.
  // A tampered payload must not ride that green path: it would end the whole
  // job green with no PR opened (a silent no-PR outcome). Both checks below
  // fire before any git/network work, so they are unit-testable as-is.
  const payload = { base: "main", title: "t", body: "b", labels: [] };
  const foreignBranch = openPrWithGh("/nonexistent", { ...payload, branch: "not-depvisor" });
  assert.equal(foreignBranch.ok, false);
  assert.equal(foreignBranch.action, "failed");
  assert.match(foreignBranch.error ?? "", /not a depvisor branch/);

  const depvisorBase = openPrWithGh("/nonexistent", {
    ...payload,
    branch: "depvisor/dev-knip",
    base: "depvisor/other",
  });
  assert.equal(depvisorBase.ok, false);
  assert.equal(depvisorBase.action, "failed");
  assert.match(depvisorBase.error ?? "", /cannot be the base/);
});

test("push is refused when a base..branch commit has a foreign committer, even with a depvisor author", () => {
  const { repo, base, sh } = tempTargetRepo();
  sh("git checkout -qb depvisor/prod-x");
  writeFileSync(join(repo, "src.ts"), "export const changed = true;\n");
  // Forged author: the resolvable display identity proves nothing, so the guard
  // must key on the committer and refuse this commit.
  sh(
    "git -c user.email=human@example.com -c user.name=human commit -aqm work " +
      '--author="github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>"',
  );
  const res = openPrWithGh(repo, {
    branch: "depvisor/prod-x",
    base,
    title: "t",
    body: "b",
    labels: [],
  });
  assert.equal(res.ok, false);
  assert.equal(res.action, "failed");
  assert.match(res.error ?? "", /committer is not depvisor/);
  assert.match(res.error ?? "", /human@example\.com/);
});

test("depvisor-committed commits pass the committer guard in both the split and pre-split styles", () => {
  const { repo, base, sh } = tempTargetRepo();
  sh("git checkout -qb depvisor/prod-x");
  writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
  // New style: resolvable github-actions[bot] author + sentinel committer.
  assert.ok(commitAll(repo, "deps: bump"));
  writeFileSync(join(repo, "src.ts"), "export const a = 2;\n");
  // Pre-split style (sentinel in BOTH fields): tips of PR branches created
  // before the author/committer split carry these and must keep refreshing.
  sh(
    'git -c "user.email=depvisor[bot]@users.noreply.github.com" -c user.name=depvisor ' +
      "commit -aqm old-style",
  );
  const res = openPrWithGh(repo, {
    branch: "depvisor/prod-x",
    base,
    title: "t",
    body: "b",
    labels: [],
  });
  // The committer guard let both commits through; the run then stops at remote
  // resolution because this fixture has no origin — reaching that point (and
  // not the committer refusal) is the assertion.
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /cannot resolve a remote URL/);
});

test("isNetworkRemote accepts network remotes", () => {
  for (const url of [
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "http://example.com/x.git",
    "ssh://git@github.com/owner/repo.git",
    "git://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    // Schemes are case-insensitive (RFC 3986).
    "HTTPS://github.com/owner/repo.git",
    "SSH://git@github.com/owner/repo.git",
    // IPv6 literals contain "::" but are network URLs, not transport helpers.
    "https://[2001:db8::1]/owner/repo.git",
    "ssh://git@[::1]/owner/repo.git",
  ]) {
    assert.equal(isNetworkRemote(url), true, url);
  }
});

test("isNetworkRemote rejects local, file, and helper remotes", () => {
  // These can run destination-side hooks in the token-holding process.
  for (const url of [
    "/tmp/evil.git",
    "./evil.git",
    "../evil.git",
    "evil.git",
    "file:///tmp/evil.git",
    "ext::sh -c 'id'",
    "EXT::sh -c 'id'", // helper names resolve case-insensitively on macOS
    "fd::17",
    "transport::/tmp/evil.git",
  ]) {
    assert.equal(isNetworkRemote(url), false, url);
  }
});

test("labelReconciliation replaces stale depvisor signals and preserves outside labels", () => {
  assert.deepEqual(
    labelReconciliation(
      ["depvisor", "semver:patch", "fixer:none", "security", "team:platform"],
      ["depvisor", "semver:minor", "fixer:applied", "dev-dependencies"],
    ),
    {
      add: ["dev-dependencies", "fixer:applied", "semver:minor"],
      remove: ["fixer:none", "security", "semver:patch"],
    },
  );
});

test("labelReconciliation deduplicates and stabilizes API-order inputs", () => {
  assert.deepEqual(
    labelReconciliation(
      ["security", "depvisor", "security", "user-label"],
      ["fixer:none", "depvisor", "fixer:none"],
    ),
    {
      add: ["fixer:none"],
      remove: ["security"],
    },
  );
});

test("binary resolution prefers root-owned system dirs over user-writable prefixes", () => {
  // System dirs must beat runner-user-writable Homebrew prefixes.
  const firstWritable = SAFE_PATH_DIRS.findIndex(
    (d) => d.includes("brew") || d.startsWith("/usr/local"),
  );
  assert.ok(firstWritable > 0, "writable fallback dirs should still be present for local dev");
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    const idx = SAFE_PATH_DIRS.indexOf(dir);
    assert.ok(idx >= 0, `${dir} must be in SAFE_PATH_DIRS`);
    assert.ok(idx < firstWritable, `${dir} must be searched before user-writable prefixes`);
  }
});

test("buildSecureEnv carries only token env and pins a clean git/gh environment", () => {
  const injected = {
    GH_TOKEN: "good-token",
    GITHUB_TOKEN: "fallback-token",
    GH_ENTERPRISE_TOKEN: "enterprise-token",
    GIT_SSH_COMMAND: "sh -c 'curl evil'",
    GIT_ASKPASS: "/tmp/evil",
    SSH_ASKPASS: "/tmp/evil",
    GIT_EXTERNAL_DIFF: "/tmp/evil",
    GIT_EXEC_PATH: "/tmp/evil-exec",
    GIT_TEMPLATE_DIR: "/tmp/evil-template",
    GIT_DIR: "/tmp/evil/.git",
    GIT_CONFIG: "/tmp/evil.cfg",
    GIT_CONFIG_GLOBAL: "/tmp/evil.cfg",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!curl evil",
    LD_PRELOAD: "/tmp/evil.so",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    NODE_OPTIONS: "--require /tmp/evil.js",
    PATH: "/tmp/evil",
    HOME: "/tmp/evil-home",
    RANDOM_AGENT_VAR: "must-not-leak",
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(injected)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const env = buildSecureEnv("/tmp/depvisor-home");
    assert.equal(env.GH_TOKEN, "good-token");
    assert.equal(env.GITHUB_TOKEN, "fallback-token");
    // GHES is not supported here, so enterprise tokens are not carried over.
    assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
    for (const k of Object.keys(injected)) {
      if (k === "GH_TOKEN" || k === "GITHUB_TOKEN") continue;
      if (k === "HOME" || k === "PATH") continue;
      assert.equal(env[k], undefined, `${k} must be scrubbed`);
    }
    // Fresh, isolated config locations; system config ignored.
    assert.equal(env.HOME, "/tmp/depvisor-home");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GH_PROMPT_DISABLED, "1");
    assert.ok(env.XDG_CONFIG_HOME?.startsWith("/tmp/depvisor-home"));
    assert.ok(env.GH_CONFIG_DIR?.startsWith("/tmp/depvisor-home"));
    // PATH is pinned to trusted system dirs (no agent-controlled entries).
    assert.ok(env.PATH?.split(":").includes("/usr/bin"));
    assert.ok(!env.PATH?.split(":").includes("/tmp/evil"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
