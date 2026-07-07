import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_EMAIL, NO_HOOKS } from "./git.ts";
import { type PrPayload, sanitizeLabels, sanitizePrBody, sanitizeSummary } from "./pr.ts";

export interface OpenPrResult {
  ok: boolean;
  /** created: new PR; updated: existing PR refreshed; blocked: policy stop. */
  action: "created" | "updated" | "blocked" | "failed";
  url: string | null;
  error: string | null;
}

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
 * Environment for every git/gh call in this token-holding step. Flue's `local()`
 * has no host isolation, so the agent can taint inherited HOME, PATH, and git
 * loader/config env. Neither a clean clone nor hook disabling covers that, so
 * every subprocess gets an allowlisted environment:
 *   - only GitHub token env vars are carried over for `gh` auth,
 *   - fresh HOME + XDG_CONFIG_HOME + GH_CONFIG_DIR under a throwaway dir, so no
 *     agent-planted global/user config is read — yet `gh auth setup-git` can
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

/** Clean checkout to push from: fresh clone, scrubbed env, verified branch sha. */
interface PreparedPush {
  clone: string;
  workDir: string;
  env: NodeJS.ProcessEnv;
  branchSha: string;
}

/**
 * Produce a clean checkout to push from, then re-verify the branch before this
 * token-holding step touches the remote. The agent can write `.git/config` in
 * the target checkout, and Git config has many command-execution hooks; pushing
 * from a fresh clone with a scrubbed env avoids repo-local, global, and
 * env-based tampering. Push-boundary checks:
 *   1. the branch name must be one depvisor produces,
 *   2. the base must be a real, non-depvisor branch (the payload is written in
 *      the tokenless step, so its `base` is not trusted),
 *   3. every commit in base..branch must be authored by depvisor.
 * On any doubt nothing is prepared and the temp dir is removed. On success the
 * caller owns `workDir` and must remove it.
 */
function prepareCleanPush(repo: string, payload: PrPayload): PreparedPush | OpenPrResult {
  if (!payload.branch.startsWith("depvisor/")) {
    return blocked(`refusing to push '${payload.branch}': not a depvisor branch`);
  }
  if (payload.base.startsWith("depvisor/")) {
    return blocked(
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

  const log = git(env, clone, ["log", "--format=%ae", `${baseRef}..${branchRef}`]);
  if (log.code !== 0) {
    return fail(
      failed(`cannot verify authorship of ${payload.base}..${payload.branch}: ${log.err}`),
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
  if (foreign.length > 0) {
    return fail(
      blocked(
        `branch ${payload.branch} has commits not authored by depvisor (${foreign.join(", ")}); refusing to push`,
      ),
    );
  }

  return { clone, workDir, env, branchSha };
}

/**
 * Apply depvisor's deterministic labels to the PR, entirely fail-soft.
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
 * Each label is ensured (`gh label create`, no `--force` so a user's existing
 * same-named label keeps its color/description; "already exists" is the expected
 * idempotent case) and then added ON ITS OWN. Per-label edits are deliberate:
 * `gh pr edit --add-label` resolves every requested name up front and, like
 * create, errors on ANY unknown one — so a single edit batching several labels
 * is all-or-nothing, and one label a transient `gh label create` failure left
 * missing would drop even the labels that do exist. All `gh` calls go through the
 * scrubbed-env helper. A label that still cannot be applied is logged (gh's error
 * carries no secret — just "label not found"/auth) and skipped, never fatal.
 */
function applyLabels(
  env: NodeJS.ProcessEnv,
  clone: string,
  branch: string,
  labels: string[],
): void {
  for (const label of labels) {
    // Ensure first; a failure here (e.g. it already exists, or a transient
    // registry hiccup) is fine — the add below is what decides the outcome.
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
 * a scrubbed environment, so agent-touched `.git/`, global git config, and
 * inherited env cannot influence the token-holding step.
 *
 * In CI, `remoteUrl` must come from a trusted source such as Actions context,
 * not from the target checkout. When omitted for trusted local dev, it falls
 * back to `remote.origin.url`. Either way, non-network remotes are refused.
 */
export function openPrWithGh(repo: string, payload: PrPayload, remoteUrl?: string): OpenPrResult {
  const prepared = prepareCleanPush(repo, payload);
  if (!("clone" in prepared)) return prepared;
  const { clone, workDir, env, branchSha } = prepared;

  // The tokenless step writes the payload; re-sanitize title/body/labels at the
  // exit boundary in case payload.json was changed after buildPrPayload.
  const title = sanitizeSummary(payload.title);
  const body = sanitizePrBody(payload.body);
  const labels = sanitizeLabels(payload.labels);

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
      return blocked(
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

    // Human-commit guard: a non-depvisor author at the remote tip means a
    // force-push would overwrite human work.
    const fetched = git(env, clone, ["fetch", "origin", payload.branch]);
    let expectedSha = ""; // empty lease = "the remote ref must not exist yet"
    if (fetched.code === 0) {
      const tipAuthor = git(env, clone, ["log", "-1", "--format=%ae", "FETCH_HEAD"]).out;
      if (tipAuthor !== AGENT_EMAIL) {
        return blocked(
          `remote ${payload.branch} tip is authored by ${tipAuthor}; refusing to force-push over human commits`,
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
      applyLabels(env, clone, payload.branch, labels);
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
      // Keep title/body in sync with the fresh payload, then reconcile labels
      // (fail-soft, separate from the title/body edit so a label hiccup cannot
      // undo it). --add-label only adds, so a group whose top semver level rose
      // between runs may briefly carry both the old and new semver:* label.
      gh(env, clone, ["pr", "edit", payload.branch, "--title", title, "--body", body]);
      applyLabels(env, clone, payload.branch, labels);
      return { ok: true, action: "updated", url: existing.out, error: null };
    }

    return failed(describePrCreateError(create.err));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
