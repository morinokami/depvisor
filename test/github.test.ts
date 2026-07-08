import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSecureEnv,
  describePrCreateError,
  isNetworkRemote,
  openPrWithGh,
  SAFE_PATH_DIRS,
} from "../src/core/github.ts";

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
