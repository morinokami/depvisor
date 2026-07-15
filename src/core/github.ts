import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_EMAIL, NO_HOOKS } from "./git.ts";
import { AFTERCARE_MARKER, sanitizeCommentBody, type ReportPayload } from "./report.ts";
import { repairScopeViolations } from "./scope.ts";

/**
 * The token-holding publish boundary. v2 publishes exactly two things, both
 * onto the UPDATER's PR — never a PR, branch, title, or body of depvisor's own:
 *
 *   1. an optional repair commit, fast-forward-pushed onto the PR's head
 *      branch only while the remote tip still equals the updater tip this run
 *      consumed (compare-and-swap; the updater rebasing or a human pushing
 *      mid-run blocks the publish instead of clobbering), and
 *   2. one marker-deduplicated report comment (created once, edited on
 *      re-runs).
 *
 * This boundary runs in its OWN job on a fresh runner: the analyze job's
 * runner executed target install/verify scripts, which can taint runner files
 * (`$GITHUB_PATH`, `$GITHUB_ENV`, `BASH_ENV`) and thereby every later step on
 * that machine — no in-process scrubbing can undo that, so the token simply
 * never appears there. Everything arriving from the analyze job (the payload,
 * the repair bundle) is untrusted data: the PR identity comes from trusted
 * action env instead and the payload must AGREE with it, the comment body is
 * re-sanitized at the exit, and the repair range is re-verified structurally —
 * bundle tip = payloaded repair sha, descendant of the expected tip, every
 * commit committed by depvisor's sentinel, and its diff clean of
 * dependency-state/execution-surface paths (`repairScopeViolations`). All
 * git/gh work runs inside a from-scratch repository pointed at the trusted
 * remote, with a scrubbed environment.
 */

export interface PublishResult {
  ok: boolean;
  /** published: comment (and push, when a repair existed) landed; blocked:
   * expected churn (PR closed, head moved); failed: a real error. */
  action: "published" | "blocked" | "failed";
  /** Whether the repair commit was pushed in THIS run. */
  pushed: boolean;
  commentUrl: string | null;
  error: string | null;
}

function blocked(error: string): PublishResult {
  return { ok: false, action: "blocked", pushed: false, commentUrl: null, error };
}

function failed(error: string): PublishResult {
  return { ok: false, action: "failed", pushed: false, commentUrl: null, error };
}

/**
 * Accept only remotes that reach a network host. Local paths, `file://`, and
 * transport helpers can run destination-side hooks inside this token-holding
 * process; network remotes run hooks on the far side.
 */
export function isNetworkRemote(url: string): boolean {
  // Check real URL schemes before looking for `::`; IPv6 literals contain `::`
  // but are network URLs, not Git transport helpers.
  if (/^(https?|ssh|git):\/\//i.test(url)) return true;
  if (url.includes("::")) return false; // transport helper: ext::, fd::, <helper>::…
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(url)) return true; // scp-like user@host:path
  return false; // local path, file://, everything else
}

// Trusted directories for `git` and `gh`. Root-owned system dirs must come
// before runner-user-writable Homebrew prefixes, which stay only as local-dev
// fallbacks.
export const SAFE_PATH_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/home/linuxbrew/.linuxbrew/bin",
];

function resolveBin(name: string): string {
  for (const dir of SAFE_PATH_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return name; // best effort; PATH in the secure env is limited to SAFE_PATH_DIRS
}

const GIT_BIN = resolveBin("git");
const GH_BIN = resolveBin("gh");

// Only token vars usable against github.com; GHES is not supported here.
const TOKEN_ENV_ALLOW = ["GH_TOKEN", "GITHUB_TOKEN"];

/**
 * Environment for every git/gh call in this token-holding step. Earlier
 * tokenless target commands can taint inherited HOME, PATH, and git loader/config
 * env. Neither a clean clone nor hook disabling covers that, so every subprocess
 * gets an allowlisted environment:
 *   - only GitHub token env vars are carried over for `gh` auth,
 *   - fresh HOME + XDG_CONFIG_HOME + GH_CONFIG_DIR under a throwaway dir, so no
 *     target-command-planted global/user config is read — yet `gh auth setup-git` can
 *     still write its credential helper into the fresh global config,
 *   - `GIT_CONFIG_NOSYSTEM=1` to ignore /etc/gitconfig,
 *   - PATH pinned to SAFE_PATH_DIRS (plus the resolved git/gh dirs).
 */
export function buildSecureEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TOKEN_ENV_ALLOW) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.GH_CONFIG_DIR = join(home, "gh");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  env.PATH = [dirname(GIT_BIN), dirname(GH_BIN), ...SAFE_PATH_DIRS]
    .filter((d) => d && d !== ".")
    .filter((d, i, all) => all.indexOf(d) === i)
    .join(":");
  return env;
}

function sh(
  env: NodeJS.ProcessEnv,
  repo: string,
  command: string,
  args: string[],
): { code: number; out: string; err: string } {
  const res = spawnSync(command, args, { cwd: repo, encoding: "utf8", env });
  return { code: res.status ?? 1, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
}

/** git (by absolute path) with hooks disabled and the scrubbed env. */
function git(
  env: NodeJS.ProcessEnv,
  repo: string,
  args: string[],
): { code: number; out: string; err: string } {
  return sh(env, repo, GIT_BIN, [...NO_HOOKS, ...args]);
}

/** gh (by absolute path) with the scrubbed env. */
function gh(
  env: NodeJS.ProcessEnv,
  repo: string,
  args: string[],
): { code: number; out: string; err: string } {
  return sh(env, repo, GH_BIN, args);
}

type GhRunner = (args: string[]) => { code: number; out: string; err: string };

const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 10;

export type ReportCommentOutcome =
  | { ok: true; url: string | null; edited: boolean }
  | { ok: false; error: string };

/**
 * Create or update the single marker-carrying report comment on the PR. The
 * hidden marker makes sequential runs idempotent: the existing comment is
 * PATCHed in place instead of stacking a new comment per synchronize event.
 * Comment reads are bounded to 1,000 entries; if the read fails, returns an
 * unexpected shape, or reaches that bound without proving the marker absent,
 * this FAILS (the report is a core deliverable in v2, so silently skipping it
 * would defeat the run) rather than risking a duplicate.
 */
export function upsertReportComment(
  prNumber: number,
  body: string,
  runGh: GhRunner,
): ReportCommentOutcome {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const listed = runGh([
      "api",
      "--method",
      "GET",
      `repos/{owner}/{repo}/issues/${prNumber}/comments`,
      "-F",
      `per_page=${COMMENTS_PER_PAGE}`,
      "-F",
      `page=${page}`,
    ]);
    if (listed.code !== 0) {
      return { ok: false, error: `could not list comments on PR #${prNumber}: ${listed.err}` };
    }
    let comments: unknown;
    try {
      comments = JSON.parse(listed.out);
    } catch {
      return { ok: false, error: `GitHub returned invalid JSON for PR #${prNumber} comments` };
    }
    if (!Array.isArray(comments)) {
      return { ok: false, error: `GitHub returned a non-array for PR #${prNumber} comments` };
    }
    const existing = comments.find(
      (comment): comment is { id: number; body: string } =>
        comment !== null &&
        typeof comment === "object" &&
        "id" in comment &&
        typeof comment.id === "number" &&
        "body" in comment &&
        typeof comment.body === "string" &&
        comment.body.includes(AFTERCARE_MARKER),
    );
    if (existing) {
      const patched = runGh([
        "api",
        "--method",
        "PATCH",
        `repos/{owner}/{repo}/issues/comments/${existing.id}`,
        "-f",
        `body=${body}`,
        "--jq",
        ".html_url",
      ]);
      if (patched.code !== 0) {
        return { ok: false, error: `could not update the report comment: ${patched.err}` };
      }
      return { ok: true, url: patched.out || null, edited: true };
    }
    if (comments.length < COMMENTS_PER_PAGE) {
      const posted = runGh([
        "api",
        "--method",
        "POST",
        `repos/{owner}/{repo}/issues/${prNumber}/comments`,
        "-f",
        `body=${body}`,
        "--jq",
        ".html_url",
      ]);
      if (posted.code !== 0) {
        return { ok: false, error: `could not post the report comment: ${posted.err}` };
      }
      return { ok: true, url: posted.out || null, edited: false };
    }
  }
  return {
    ok: false,
    error: `could not prove the report marker absent within ${COMMENTS_PER_PAGE * MAX_COMMENT_PAGES} comments on PR #${prNumber}`,
  };
}

/** The PR identity the publish step trusts — action env, never the payload. */
export interface TrustedPrContext {
  prNumber: number;
  headRef: string;
  /**
   * Trusted push target (Actions context `${server_url}/${repository}`; the
   * same value set by hand for local dev). Required: the publish job has no
   * target checkout to fall back to — by design, it never shares a runner
   * with anything that executed target code.
   */
  remoteUrl: string;
}

/**
 * Publish one aftercare result: verify the PR is still open on the expected
 * head, fast-forward-push the repair commit (when one exists, carried by the
 * git bundle), and upsert the report comment. See the module doc for the
 * trust argument. On any doubt the temp workspace is removed and nothing is
 * pushed.
 *
 * This function runs on a FRESH runner that never executed target code (the
 * analyze/publish job split): it builds its working repository from the
 * trusted remote URL, never from the analyze job's checkout, whose runner
 * files (`$GITHUB_PATH`, `$GITHUB_ENV`, `BASH_ENV`, `.git`) target scripts
 * can taint. The repair commits arrive as `bundlePath` — untrusted data,
 * verified structurally below before anything is pushed.
 */
export function publishAftercare(
  payload: ReportPayload,
  trusted: TrustedPrContext,
  bundlePath: string | null,
): PublishResult {
  // The payload must agree with the trusted identity; a mismatch means the
  // payload file was rewritten after the workflow emitted it.
  if (payload.headRef !== trusted.headRef) {
    return failed(
      `payload head ref '${payload.headRef}' does not match the trusted head ref '${trusted.headRef}'; refusing to publish`,
    );
  }
  if (payload.prNumber !== null && payload.prNumber !== trusted.prNumber) {
    return failed(
      `payload PR #${payload.prNumber} does not match the trusted PR #${trusted.prNumber}; refusing to publish`,
    );
  }
  const pushUrl = trusted.remoteUrl.trim();
  if (!pushUrl) {
    return failed("cannot resolve a remote URL to publish to");
  }
  if (!isNetworkRemote(pushUrl)) {
    return failed(
      `refusing to publish to non-network remote '${pushUrl}': a local/file/helper target would run its server-side hooks in this token-holding process`,
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), "depvisor-publish-"));
  const home = join(workDir, "home");
  mkdirSync(home);
  const clone = join(workDir, "repo");
  const env = buildSecureEnv(home);

  try {
    // A fresh repository pointed at the trusted remote — built from nothing,
    // so no pre-existing .git (from any checkout) is ever consulted.
    const init = git(env, workDir, ["init", "--quiet", clone]);
    if (init.code !== 0) {
      return failed(`could not prepare a clean repository to publish from: ${init.err}`);
    }
    const addRemote = git(env, clone, ["remote", "add", "origin", pushUrl]);
    if (addRemote.code !== 0) {
      return failed(`could not point the clean repository at the remote: ${addRemote.err}`);
    }

    // Configure git to authenticate through gh/GH_TOKEN. Non-fatal: without a
    // token the fetch below fails with a clear auth error. Fresh HOME prevents
    // ambient credentials from being picked up.
    gh(env, clone, ["auth", "setup-git"]);

    // The PR must still be open, on the branch the trusted context names. A
    // merged/closed PR is expected churn (green blocked); an unverifiable
    // state fails closed — publishing blind is exactly what this check exists
    // to prevent.
    const viewed = gh(env, clone, [
      "pr",
      "view",
      String(trusted.prNumber),
      "--json",
      "state,headRefName",
      "--jq",
      '[.state, .headRefName] | join("\\u0000")',
    ]);
    if (viewed.code !== 0) {
      return failed(`could not verify PR #${trusted.prNumber}: ${viewed.err}`);
    }
    const [state, headRefName] = viewed.out.split("\u0000");
    if (state !== "OPEN") {
      return blocked(
        `PR #${trusted.prNumber} is no longer open (${state ?? "unknown state"}); nothing to publish`,
      );
    }
    if (headRefName !== trusted.headRef) {
      return failed(
        `PR #${trusted.prNumber} head is '${headRefName ?? ""}', not the trusted '${trusted.headRef}'; refusing to publish`,
      );
    }

    // Compare-and-swap anchor: the remote tip must still be the updater tip
    // this run consumed — unless it already equals the repair commit (an
    // idempotent re-run after a successful push). --no-tags: only the branch.
    const fetched = git(env, clone, [
      "fetch",
      "--no-tags",
      "origin",
      `refs/heads/${trusted.headRef}`,
    ]);
    if (fetched.code !== 0) {
      return failed(`could not fetch the remote head of ${trusted.headRef}: ${fetched.err}`);
    }
    const remoteTip = git(env, clone, ["rev-parse", "FETCH_HEAD"]).out;
    const alreadyPushed = payload.repairSha !== null && remoteTip === payload.repairSha;
    if (remoteTip !== payload.expectedHeadSha && !alreadyPushed) {
      return blocked(
        `the remote head of ${trusted.headRef} moved (expected ${payload.expectedHeadSha.slice(0, 8)}, found ${remoteTip.slice(0, 8)}); the updater rebased or a human pushed — re-run on the new head`,
      );
    }

    let pushed = false;
    if (payload.repairSha !== null && !alreadyPushed) {
      // The repair commits travel as a bundle from the analyze job. Verify the
      // bundle's prerequisites against what we fetched (the expected tip),
      // then bring its commits in under a private ref.
      if (bundlePath === null) {
        return failed("a repair commit is payloaded but no repair bundle was provided");
      }
      const verified = git(env, clone, ["bundle", "verify", bundlePath]);
      if (verified.code !== 0) {
        return failed(`the repair bundle does not apply to the expected head: ${verified.err}`);
      }
      const applied = git(env, clone, [
        "fetch",
        "--no-tags",
        bundlePath,
        `refs/heads/${trusted.headRef}:refs/depvisor/repair`,
      ]);
      if (applied.code !== 0) {
        return failed(`could not read the repair bundle: ${applied.err}`);
      }
      const bundleTip = git(env, clone, ["rev-parse", "refs/depvisor/repair"]).out;
      if (bundleTip !== payload.repairSha) {
        return failed(
          `the repair bundle's tip (${bundleTip.slice(0, 8)}) is not the payload's repair commit (${payload.repairSha.slice(0, 8)}); refusing to push`,
        );
      }

      // Structural re-verification of the repair range inside the clean clone.
      // The expected tip must be an ancestor of the repair commit…
      const anchor = git(env, clone, ["merge-base", payload.repairSha, payload.expectedHeadSha]);
      if (anchor.code !== 0 || anchor.out !== payload.expectedHeadSha) {
        return failed(
          `repair commit ${payload.repairSha.slice(0, 8)} does not descend from the expected head; refusing to push`,
        );
      }
      // …every commit in between must carry depvisor's committer sentinel (%ce,
      // not %ae: the author is a resolvable display identity — git.ts — and any
      // human rebase/amend rewrites the committer)…
      const log = git(env, clone, [
        "log",
        "--format=%ce",
        `${payload.expectedHeadSha}..${payload.repairSha}`,
      ]);
      if (log.code !== 0) {
        return failed(`cannot verify the repair range's committers: ${log.err}`);
      }
      const foreign = [
        ...new Set(
          log.out
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((email) => email !== AGENT_EMAIL),
        ),
      ];
      if (foreign.length > 0) {
        return failed(
          `the repair range contains commits whose committer is not depvisor (${foreign.join(", ")}); refusing to push`,
        );
      }
      // …and its committed diff must pass the repair scope rule again.
      const diffed = git(env, clone, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        payload.expectedHeadSha,
        payload.repairSha,
      ]);
      if (diffed.code !== 0) {
        return failed(`cannot inspect the repair diff: ${diffed.err}`);
      }
      const violations = repairScopeViolations(diffed.out.split("\u0000").filter(Boolean));
      if (violations.length > 0) {
        return failed(
          `the repair diff touches out-of-scope paths (${violations.toSorted().join(", ")}); refusing to push`,
        );
      }

      // Plain push, no force: the server enforces fast-forward, so a race with
      // the updater between the fetch above and here still cannot clobber.
      const push = git(env, clone, [
        "push",
        "origin",
        `${payload.repairSha}:refs/heads/${trusted.headRef}`,
      ]);
      if (push.code !== 0) {
        return /non-fast-forward|fetch first|\[rejected\]/i.test(push.err)
          ? blocked(
              `the remote head of ${trusted.headRef} moved while publishing; nothing was pushed — re-run on the new head`,
            )
          : failed(`git push failed: ${push.err}`);
      }
      pushed = true;
    }

    // The report comment. Re-sanitized at this exit boundary because the
    // payload file is untrusted here; the marker survives for idempotency.
    const body = sanitizeCommentBody(payload.commentBody);
    const comment = upsertReportComment(trusted.prNumber, body, (args) => gh(env, clone, args));
    if (!comment.ok) {
      // A pushed repair with a failed comment is a partial publish: report it
      // red so the missing report is noticed, but say what did land.
      return {
        ok: false,
        action: "failed",
        pushed,
        commentUrl: null,
        error: pushed ? `repair pushed, but ${comment.error}` : comment.error,
      };
    }
    return { ok: true, action: "published", pushed, commentUrl: comment.url, error: null };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
