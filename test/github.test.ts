import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSecureEnv,
  isNetworkRemote,
  publishAftercare,
  SAFE_PATH_DIRS,
  upsertReportComment,
} from "../src/core/github.ts";
import { AFTERCARE_MARKER, type ReportPayload } from "../src/core/report.ts";

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

// upsertReportComment is what makes the report idempotent across synchronize
// events: one marker-carrying comment, PATCHed in place, never stacked.

const REPORT_BODY = `report body\n\n${AFTERCARE_MARKER}`;

test("report comment: an existing marker comment is PATCHed in place (edited)", () => {
  const calls: string[][] = [];
  const outcome = upsertReportComment(7, REPORT_BODY, (args) => {
    calls.push(args);
    if (args.includes("GET")) {
      // The marker check must key on the comment BODY, not position or author.
      return {
        code: 0,
        out: JSON.stringify([
          { id: 1, body: "ordinary comment" },
          { id: 42, body: `previous report\n\n${AFTERCARE_MARKER}` },
        ]),
        err: "",
      };
    }
    return { code: 0, out: "https://github.com/acme/repo/pull/7#issuecomment-42", err: "" };
  });

  assert.deepEqual(outcome, {
    ok: true,
    url: "https://github.com/acme/repo/pull/7#issuecomment-42",
    edited: true,
  });
  assert.deepEqual(calls[0], [
    "api",
    "--method",
    "GET",
    "repos/{owner}/{repo}/issues/7/comments",
    "-F",
    "per_page=100",
    "-F",
    "page=1",
  ]);
  // The PATCH targets the marker comment's id and rewrites its body.
  assert.deepEqual(calls[1], [
    "api",
    "--method",
    "PATCH",
    "repos/{owner}/{repo}/issues/comments/42",
    "-f",
    `body=${REPORT_BODY}`,
    "--jq",
    ".html_url",
  ]);
});

test("report comment: a short markerless page proves absence and POSTs a new comment", () => {
  const calls: string[][] = [];
  const outcome = upsertReportComment(7, REPORT_BODY, (args) => {
    calls.push(args);
    if (args.includes("GET")) {
      // < 100 entries: the page is final, so the marker is provably absent.
      return {
        code: 0,
        out: JSON.stringify([{ id: 1, body: "ordinary comment" }]),
        err: "",
      };
    }
    return { code: 0, out: "https://github.com/acme/repo/pull/7#issuecomment-9", err: "" };
  });

  assert.deepEqual(outcome, {
    ok: true,
    url: "https://github.com/acme/repo/pull/7#issuecomment-9",
    edited: false,
  });
  assert.deepEqual(calls[1], [
    "api",
    "--method",
    "POST",
    "repos/{owner}/{repo}/issues/7/comments",
    "-f",
    `body=${REPORT_BODY}`,
    "--jq",
    ".html_url",
  ]);
});

test("report comment: a failed or malformed list read fails, never posts blind", () => {
  // The report is a core deliverable, so an unreadable comment list is a red
  // failure — silently posting could stack duplicates.
  const listFailure = upsertReportComment(7, REPORT_BODY, () => ({
    code: 1,
    out: "",
    err: "HTTP 502",
  }));
  assert.equal(listFailure.ok, false);
  assert.match(listFailure.ok ? "" : listFailure.error, /could not list comments on PR #7/);

  const notJson = upsertReportComment(7, REPORT_BODY, (args) => {
    assert.ok(args.includes("GET"), "must not POST/PATCH after a malformed list");
    return { code: 0, out: "<html>rate limited</html>", err: "" };
  });
  assert.equal(notJson.ok, false);
  assert.match(notJson.ok ? "" : notJson.error, /invalid JSON/);

  const notArray = upsertReportComment(7, REPORT_BODY, (args) => {
    assert.ok(args.includes("GET"), "must not POST/PATCH after a non-array list");
    return { code: 0, out: JSON.stringify({ message: "Not Found" }), err: "" };
  });
  assert.equal(notArray.ok, false);
  assert.match(notArray.ok ? "" : notArray.error, /non-array/);
});

test("report comment: ten full markerless pages cannot prove absence — bounded failure, no POST", () => {
  const fullPage = JSON.stringify(
    Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `comment ${i}` })),
  );
  const pagesSeen: string[] = [];
  const outcome = upsertReportComment(7, REPORT_BODY, (args) => {
    assert.ok(args.includes("GET"), "must not POST after an inconclusive scan");
    const page = args.find((a) => a.startsWith("page="));
    if (page) pagesSeen.push(page);
    return { code: 0, out: fullPage, err: "" };
  });

  assert.equal(outcome.ok, false);
  // 100 per page × 10 pages = the 1,000-comment read bound.
  assert.match(outcome.ok ? "" : outcome.error, /1000 comments on PR #7/);
  assert.deepEqual(
    pagesSeen,
    Array.from({ length: 10 }, (_, i) => `page=${i + 1}`),
  );
});

// publishAftercare's pre-clone guards: the payload is an untrusted read-back
// (the tokenless step wrote it), so it must AGREE with the trusted action env
// before any git/network work happens. Only these guards are unit-testable —
// everything past them drives a clone.

function minimalPayload(overrides: Partial<ReportPayload> = {}): ReportPayload {
  return {
    prNumber: 7,
    headRef: "dependabot/npm_and_yarn/lru-cache-11.0.0",
    baseRef: "main",
    expectedHeadSha: "a".repeat(40),
    repairSha: null,
    commentBody: REPORT_BODY,
    ...overrides,
  };
}

test("publishAftercare refuses a payload whose head ref disagrees with the trusted context", () => {
  // A rewritten payload naming another branch must be a red failure, not a
  // green blocked: it is tampering evidence, not expected churn.
  const res = publishAftercare("/nonexistent", minimalPayload(), {
    prNumber: 7,
    headRef: "renovate/other-branch",
  });
  assert.equal(res.ok, false);
  assert.equal(res.action, "failed");
  assert.equal(res.pushed, false);
  assert.equal(res.commentUrl, null);
  assert.match(res.error ?? "", /head ref/);
  assert.match(res.error ?? "", /refusing to publish/);
});

test("publishAftercare refuses a payload whose PR number disagrees with the trusted context", () => {
  const res = publishAftercare(
    "/nonexistent",
    minimalPayload({ prNumber: 8 }), // head refs agree; the PR number does not
    { prNumber: 7, headRef: "dependabot/npm_and_yarn/lru-cache-11.0.0" },
  );
  assert.equal(res.ok, false);
  assert.equal(res.action, "failed");
  assert.equal(res.pushed, false);
  assert.match(res.error ?? "", /PR #8/);
  assert.match(res.error ?? "", /trusted PR #7/);
});
