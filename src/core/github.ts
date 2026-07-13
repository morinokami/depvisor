import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_EMAIL, NO_HOOKS } from "./git.ts";
import {
  isDepvisorManagedLabel,
  type PrPayload,
  sanitizeLabels,
  sanitizePrBody,
  sanitizeSummary,
} from "./pr.ts";

export interface OpenPrResult {
  ok: boolean;
  /** created: new PR; updated: existing PR refreshed; blocked: expected human intervention. */
  action: "created" | "updated" | "blocked" | "failed";
  url: string | null;
  error: string | null;
}

export type HumanTakeoverCommentOutcome =
  | "posted"
  | "already-present"
  | "no-open-pr"
  | "unavailable";

export const OPEN_PR_BLOCKED_MARKER = "<!-- depvisor:open-pr-blocked -->";

export const OPEN_PR_BLOCKED_COMMENT = `depvisor stopped updating this PR because its head branch contains a commit that was not committed by depvisor. This avoids overwriting work on the branch with a force-push.

To let depvisor manage this dependency update again, merge or close this PR and delete its head branch. If the update is still needed, depvisor may prepare it again on a future run.

${OPEN_PR_BLOCKED_MARKER}`;

/**
 * Reserved for the expected policy stops caused by ordinary human action on
 * the PR, which open-pr records as the green `open-pr-blocked` — exactly what
 * the status reference (docs/results.md) documents that status to mean:
 *   - a human took over the PR branch (the remote tip carries their commits),
 *   - in conflict-refresh-only mode, the target PR was merged/closed while the
 *     run was in flight, so there is nothing left to refresh.
 * Every other push-boundary refusal (non-depvisor branch or base, a foreign
 * committer in the local range, non-network remote) signals payload/config
 * tampering or misconfiguration and must go through failed(): a green
 * "blocked" there would end the whole job green with no PR opened — a silent
 * no-PR outcome, which the status design promises to surface.
 */
function blocked(error: string): OpenPrResult {
  return { ok: false, action: "blocked", url: null, error };
}

function failed(error: string): OpenPrResult {
  return { ok: false, action: "failed", url: null, error };
}

/**
 * Attach a fix-it hint to well-known `gh pr create` failures. The most common
 * first-run failure — the repository setting that forbids Actions from creating
 * PRs — surfaces as a raw GraphQL error that names no setting, and it lands
 * only AFTER the agent step has already spent LLM tokens, so the message must
 * point straight at the fix. Anything unrecognized passes through unchanged.
 */
export function describePrCreateError(error: string): string {
  if (/not permitted to create or approve pull requests/i.test(error)) {
    return (
      `${error} — enable "Allow GitHub Actions to create and approve pull requests" ` +
      "(repository Settings → Actions → General → Workflow permissions), or pass a " +
      "GitHub App / PAT token with pull-request write access as the github_token input."
    );
  }
  return error;
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

/**
 * Leave one deterministic, best-effort notice when the human-commit guard takes
 * ownership away from depvisor. This helper runs only after the branch has
 * passed prepareCleanPush's validation, and production supplies a GhRunner
 * closed over the fresh clone and scrubbed environment.
 *
 * The hidden marker makes sequential runs idempotent. Comment reads are bounded
 * to 1,000 entries; if the read fails, returns an unexpected shape, or reaches
 * that bound without proving the list is exhausted, the safe fail-soft choice
 * is to skip posting rather than risk a duplicate. The workflow's documented
 * concurrency closes the ordinary read-then-create race, though this is not a
 * globally atomic uniqueness guarantee.
 */
export function notifyHumanTakeoverComment(
  branch: string,
  runGh: GhRunner,
): HumanTakeoverCommentOutcome {
  try {
    const viewed = runGh([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
      "--jq",
      ".[0].number",
    ]);
    if (viewed.code !== 0) {
      console.warn(`note: could not find the open PR for blocked branch ${branch}: ${viewed.err}`);
      return "unavailable";
    }
    const numberText = viewed.out.trim();
    if (!/^[1-9]\d*$/.test(numberText)) {
      console.warn(`note: blocked branch ${branch} no longer has an open PR to comment on`);
      return "no-open-pr";
    }
    const number = Number(numberText);
    if (!Number.isSafeInteger(number)) {
      console.warn(`note: open PR number for blocked branch ${branch} was not a safe integer`);
      return "unavailable";
    }

    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const listed = runGh([
        "api",
        "--method",
        "GET",
        `repos/{owner}/{repo}/issues/${number}/comments`,
        "-F",
        `per_page=${COMMENTS_PER_PAGE}`,
        "-F",
        `page=${page}`,
      ]);
      if (listed.code !== 0) {
        console.warn(`note: could not inspect comments on PR #${number}: ${listed.err}`);
        return "unavailable";
      }

      let comments: unknown;
      try {
        comments = JSON.parse(listed.out);
      } catch {
        console.warn(
          `note: could not inspect comments on PR #${number}: GitHub returned invalid JSON`,
        );
        return "unavailable";
      }
      if (!Array.isArray(comments)) {
        console.warn(
          `note: could not inspect comments on PR #${number}: GitHub returned a non-array`,
        );
        return "unavailable";
      }
      if (
        comments.some(
          (comment) =>
            comment !== null &&
            typeof comment === "object" &&
            "body" in comment &&
            typeof comment.body === "string" &&
            comment.body.includes(OPEN_PR_BLOCKED_MARKER),
        )
      ) {
        return "already-present";
      }
      if (comments.length < COMMENTS_PER_PAGE) {
        const posted = runGh(["pr", "comment", String(number), "--body", OPEN_PR_BLOCKED_COMMENT]);
        if (posted.code !== 0) {
          console.warn(`note: could not comment on blocked PR #${number}: ${posted.err}`);
          return "unavailable";
        }
        console.log(`  commented on PR #${number}: depvisor will not overwrite the human commit`);
        return "posted";
      }
    }

    console.warn(
      `note: skipped commenting on blocked PR #${number}: could not prove the marker was absent within ${COMMENTS_PER_PAGE * MAX_COMMENT_PAGES} comments`,
    );
    return "unavailable";
  } catch (err) {
    const message = Error.isError(err) ? err.message : String(err);
    console.warn(`note: could not notify the open PR for blocked branch ${branch}: ${message}`);
    return "unavailable";
  }
}

/** gh (by absolute path) for other token-holding entrypoints using the same scrubbed env. */
export function runSecureGh(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
): { code: number; out: string; err: string } {
  return gh(env, cwd, args);
}

/** Clean checkout to push from: fresh clone, scrubbed env, verified branch sha. */
interface PreparedPush {
  clone: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
  branchSha: string;
}

/**
 * Produce a clean checkout to push from, then re-verify the branch before this
 * token-holding step touches the remote. Target lifecycle/verification commands
 * can write `.git/config`, and Git config has many command-execution hooks;
 * pushing from a fresh clone with a scrubbed env avoids repo-local, global, and
 * env-based tampering. Push-boundary checks:
 *   1. the branch name must be one depvisor produces,
 *   2. the base must be a real, non-depvisor branch (the payload is written in
 *      the tokenless step, so its `base` is not trusted),
 *   3. every commit in base..branch must have depvisor as its COMMITTER — the
 *      author is deliberately a resolvable display identity (git.ts) and so
 *      proves nothing.
 * On any doubt nothing is prepared and the temp dir is removed. On success the
 * caller owns `workDir` and must remove it.
 */
function prepareCleanPush(repo: string, payload: PrPayload): PreparedPush | OpenPrResult {
  if (!payload.branch.startsWith("depvisor/")) {
    return failed(`refusing to push '${payload.branch}': not a depvisor branch`);
  }
  if (payload.base.startsWith("depvisor/")) {
    return failed(
      `refusing to open a PR against base '${payload.base}': a depvisor branch cannot be the base`,
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), "depvisor-openpr-"));
  const home = join(workDir, "home");
  mkdirSync(home);
  const clone = join(workDir, "repo");
  const env = buildSecureEnv(home);
  const fail = (result: OpenPrResult): OpenPrResult => {
    rmSync(workDir, { recursive: true, force: true });
    return result;
  };

  // Clone from the fresh temp dir, not inside `repo`, so git never treats the
  // target checkout as the current repository and reads its config.
  const cloned = git(env, workDir, ["clone", "--quiet", repo, clone]);
  if (cloned.code !== 0) {
    return fail(failed(`could not prepare a clean checkout to push from: ${cloned.err}`));
  }

  const baseRef = `refs/remotes/origin/${payload.base}`;
  const branchRef = `refs/remotes/origin/${payload.branch}`;
  if (git(env, clone, ["rev-parse", "--verify", "--quiet", baseRef]).code !== 0) {
    return fail(failed(`base branch '${payload.base}' does not exist; refusing to push`));
  }
  if (git(env, clone, ["rev-parse", "--verify", "--quiet", branchRef]).code !== 0) {
    return fail(failed(`branch '${payload.branch}' not found; refusing to push`));
  }
  const branchSha = git(env, clone, ["rev-parse", branchRef]).out;

  // %ce, not %ae: the author is deliberately a resolvable display identity
  // (git.ts:AGENT_AUTHOR), so only the committer marks depvisor's own commit
  // objects — and any human rebase/amend/web-UI edit rewrites the committer.
  const log = git(env, clone, ["log", "--format=%ce", `${baseRef}..${branchRef}`]);
  if (log.code !== 0) {
    return fail(
      failed(`cannot verify the committers of ${payload.base}..${payload.branch}: ${log.err}`),
    );
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
  // A foreign committer in the LOCAL base..branch range is tampering, not a
  // human takeover: in CI nothing human can commit to the checkout between the
  // agent step and this one (the remote-tip takeover check below in
  // openPrWithGh is the expected-green case).
  if (foreign.length > 0) {
    return fail(
      failed(
        `branch ${payload.branch} has commits whose committer is not depvisor (${foreign.join(", ")}); refusing to push`,
      ),
    );
  }

  return { clone, workDir, env, branchSha };
}

export interface LabelReconciliation {
  add: string[];
  remove: string[];
}

/**
 * Compute the exact best-effort reconciliation for depvisor-owned labels.
 * Labels outside that vocabulary are never removed. `preserve` exempts labels
 * from removal this run because the input behind them was unavailable rather
 * than negative (today: `security` when the fail-open advisory lookup failed —
 * its absence from `desired` is then missing data, not evidence). Inputs may
 * come back in arbitrary API order, so both outputs are deduplicated and
 * sorted for deterministic `gh` calls.
 */
export function labelReconciliation(
  current: readonly string[],
  desired: readonly string[],
  preserve: readonly string[] = [],
): LabelReconciliation {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  const preserveSet = new Set(preserve);
  return {
    add: [...desiredSet].filter((label) => !currentSet.has(label)).toSorted(),
    remove: [...currentSet]
      .filter(
        (label) =>
          isDepvisorManagedLabel(label) && !desiredSet.has(label) && !preserveSet.has(label),
      )
      .toSorted(),
  };
}

/**
 * Reconcile depvisor's deterministic labels on the PR, entirely fail-soft.
 *
 * The main objective is the PR itself, so nothing here may fail it — that is why
 * labels are applied AFTER `gh pr create`, never passed to it: `gh pr create
 * --label <unknown>` aborts creation, turning a missing label into a lost PR.
 *
 * Both creating a label and applying it need only `pull-requests: write` (the
 * scope that already opened the PR): GitHub's label REST endpoint accepts either
 * `issues` or `pull-requests` write, verified empirically against the standard
 * `GITHUB_TOKEN` — no `issues: write` is required.
 *
 * Existing labels are read first. Obsolete labels within depvisor's fixed
 * vocabulary are removed (except `preserve`, see `labelReconciliation`),
 * desired missing labels are ensured (`gh label create`, no `--force`) and
 * added, and labels outside the vocabulary are untouched. Per-label edits keep
 * a single API failure isolated. A read/remove/create/add failure is logged
 * and skipped, never fatal: these labels describe review provenance but are
 * not a security gate or merge authorization. All calls use the scrubbed
 * environment.
 */
function reconcileLabels(
  env: NodeJS.ProcessEnv,
  clone: string,
  branch: string,
  labels: string[],
  preserve: readonly string[],
): void {
  const viewed = gh(env, clone, [
    "pr",
    "view",
    branch,
    "--json",
    "labels",
    "--jq",
    ".labels[].name",
  ]);
  const current =
    viewed.code === 0
      ? viewed.out
          .split("\n")
          .map((label) => label.trim())
          .filter(Boolean)
      : [];
  if (viewed.code !== 0) {
    console.warn(
      `note: could not inspect labels on ${branch}; adding the desired set without removals: ${viewed.err}`,
    );
  }

  const reconciliation = labelReconciliation(current, labels, preserve);
  for (const label of reconciliation.remove) {
    const removed = gh(env, clone, ["pr", "edit", branch, "--remove-label", label]);
    if (removed.code !== 0) {
      console.warn(`note: could not remove stale label '${label}' from ${branch}: ${removed.err}`);
    }
  }
  for (const label of reconciliation.add) {
    // Ensure first; a failure here is fine — the add below decides whether the
    // desired label reached the PR.
    gh(env, clone, ["label", "create", label]);
    const added = gh(env, clone, ["pr", "edit", branch, "--add-label", label]);
    if (added.code !== 0) {
      console.warn(`note: could not apply label '${label}' to ${branch}: ${added.err}`);
    }
  }
}

/**
 * Push the update branch and open (or refresh) the PR via the `gh` CLI.
 *
 * This is the only code that touches a token, and it runs in a separate
 * workflow step from the agent. All git/gh work runs inside a fresh clone with
 * a scrubbed environment, so target-command-touched `.git/`, global git config,
 * and inherited env cannot influence the token-holding step.
 *
 * In CI, `remoteUrl` must come from a trusted source such as Actions context,
 * not from the target checkout. When omitted for trusted local dev, it falls
 * back to `remote.origin.url`. Either way, non-network remotes are refused.
 *
 * `conflictRefreshOnly` re-enforces the closed-world mode at this exit
 * boundary: the tokenless step selected conflicted PRs from a snapshot taken
 * before install/verification/LLM work, so the target PR can be merged or
 * closed while the run is in flight. In that mode the still-open PR is
 * re-verified before anything is pushed (a merge can auto-delete the branch,
 * which the push would otherwise resurrect), and `gh pr create` is never
 * called — a vanished PR is a green `blocked`, never a new PR. The flag must
 * come from trusted workflow env, NOT the payload: the payload is an untrusted
 * read-back at this boundary, so a mode bit inside it could be forged off.
 */
export function openPrWithGh(
  repo: string,
  payload: PrPayload,
  remoteUrl?: string,
  conflictRefreshOnly = false,
): OpenPrResult {
  const prepared = prepareCleanPush(repo, payload);
  if (!("clone" in prepared)) return prepared;
  const { clone, workDir, env, branchSha } = prepared;

  // The tokenless step writes the payload; re-sanitize title/body/labels at the
  // exit boundary in case payload.json was changed after buildPrPayload.
  const title = sanitizeSummary(payload.title);
  const body = sanitizePrBody(payload.body);
  const labels = sanitizeLabels(payload.labels);
  // `security` rides the one fail-open input (the advisory lookup); when that
  // lookup failed this run, an existing label must survive the reconcile. A
  // tampered/mistyped payload field lands on the fail-safe (preserving) side:
  // parsePrPayload already coerced anything but `true` to false.
  const preserveLabels = payload.advisoriesOk ? [] : ["security"];

  try {
    // Prefer the trusted URL; only fall back to target config for local dev.
    // `config --get` reads the raw value and ignores `url.*.insteadOf`.
    const pushUrl =
      remoteUrl && remoteUrl.trim()
        ? remoteUrl.trim()
        : git(env, repo, ["config", "--get", "remote.origin.url"]).out;
    if (!pushUrl) {
      return failed("cannot resolve a remote URL to push to");
    }
    if (!isNetworkRemote(pushUrl)) {
      return failed(
        `refusing to push to non-network remote '${pushUrl}': a local/file/helper target would run its server-side hooks in this token-holding process`,
      );
    }
    // The clone's origin is the local source path, so point it at the remote.
    const setUrl = git(env, clone, ["remote", "set-url", "origin", pushUrl]);
    if (setUrl.code !== 0) {
      return failed(`could not point the clean checkout at the remote: ${setUrl.err}`);
    }

    // Configure git to authenticate through gh/GH_TOKEN. Non-fatal: without a
    // token the push below fails with a clear auth error. Fresh HOME prevents
    // ambient credentials from being picked up.
    gh(env, clone, ["auth", "setup-git"]);

    // Closed-world re-check: the snapshot that selected this group is minutes
    // old by now. Refresh-only may only touch a PR that is STILL open — if it
    // was merged/closed mid-run there is nothing to refresh, and pushing would
    // resurrect an auto-deleted branch. An unverifiable state fails closed
    // (red): this is a gate in this mode, and a green skip on an API outage
    // would be a silent no-PR outcome.
    let refreshUrl = "";
    if (conflictRefreshOnly) {
      const open = gh(env, clone, [
        "pr",
        "list",
        "--head",
        payload.branch,
        "--state",
        "open",
        "--json",
        "url",
        "--jq",
        ".[0].url",
      ]);
      if (open.code !== 0) {
        return failed(
          `conflict-refresh-only: could not re-verify that the ${payload.branch} PR is still open: ${open.err}`,
        );
      }
      if (!open.out) {
        return blocked(
          `conflict-refresh-only: the PR for ${payload.branch} is no longer open (merged or closed while the run was in flight); refusing to push or open a new PR`,
        );
      }
      refreshUrl = open.out;
    }

    // Human-commit guard: a non-depvisor committer at the remote tip means a
    // force-push would overwrite human work. %ce for the same reason as the
    // local-range check above — the resolvable author proves nothing.
    const fetched = git(env, clone, ["fetch", "origin", payload.branch]);
    let expectedSha = ""; // empty lease = "the remote ref must not exist yet"
    if (fetched.code === 0) {
      const tipCommitter = git(env, clone, ["log", "-1", "--format=%ce", "FETCH_HEAD"]).out;
      if (tipCommitter !== AGENT_EMAIL) {
        notifyHumanTakeoverComment(payload.branch, (args) => gh(env, clone, args));
        return blocked(
          `remote ${payload.branch} tip was committed by ${tipCommitter}; refusing to force-push over human commits`,
        );
      }
      expectedSha = git(env, clone, ["rev-parse", "FETCH_HEAD"]).out;
    }

    const push = git(env, clone, [
      "push",
      `--force-with-lease=refs/heads/${payload.branch}:${expectedSha}`,
      "origin",
      `${branchSha}:refs/heads/${payload.branch}`,
    ]);
    if (push.code !== 0) {
      return failed(`git push failed: ${push.err}`);
    }

    // Refresh-only never reaches `gh pr create`: the push above refreshed the
    // still-open PR verified before it, so go straight to the edit/reconcile
    // path. If the PR closed in the seconds since that check, the worst case
    // is a pushed branch — the open-PR set still cannot grow in this mode.
    if (conflictRefreshOnly) {
      return refreshExistingPr(
        env,
        clone,
        payload,
        title,
        body,
        labels,
        preserveLabels,
        refreshUrl,
      );
    }

    const create = gh(env, clone, [
      "pr",
      "create",
      "--base",
      payload.base,
      "--head",
      payload.branch,
      "--title",
      title,
      "--body",
      body,
    ]);
    if (create.code === 0) {
      reconcileLabels(env, clone, payload.branch, labels, preserveLabels);
      return { ok: true, action: "created", url: create.out, error: null };
    }

    // `gh pr create` fails when a PR already exists for this head — that is the
    // idempotent success case (the push above already refreshed it), not an error.
    const existing = gh(env, clone, [
      "pr",
      "list",
      "--head",
      payload.branch,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ]);
    if (existing.code === 0 && existing.out) {
      return refreshExistingPr(
        env,
        clone,
        payload,
        title,
        body,
        labels,
        preserveLabels,
        existing.out,
      );
    }

    return failed(describePrCreateError(create.err));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Sync an already-pushed, already-open PR with the fresh payload. Keep
 * title/body in sync, then reconcile labels (fail-soft, separate from the
 * title/body edit so a label hiccup cannot undo it). Reconciliation removes
 * obsolete depvisor-owned review signals while preserving every label outside
 * that vocabulary. A failed edit stays fail-soft (the push already refreshed
 * the commits, and the stale marker makes the next run retry the refresh) but
 * must not be silent.
 */
function refreshExistingPr(
  env: NodeJS.ProcessEnv,
  clone: string,
  payload: PrPayload,
  title: string,
  body: string,
  labels: string[],
  preserveLabels: string[],
  url: string,
): OpenPrResult {
  const edited = gh(env, clone, ["pr", "edit", payload.branch, "--title", title, "--body", body]);
  if (edited.code !== 0) {
    console.warn(`note: could not refresh title/body of ${payload.branch}: ${edited.err}`);
  }
  reconcileLabels(env, clone, payload.branch, labels, preserveLabels);
  return { ok: true, action: "updated", url, error: null };
}
