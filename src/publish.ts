/**
 * Token-holding publication boundary for v2.
 *
 * The agent never receives GH_TOKEN. This step rechecks the updater-owned state,
 * current PR head, and captured working-tree repair, then creates at most one
 * commit on the existing updater branch and creates/updates one marker comment.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeNewRepairFiles } from "./core/apply-repair.ts";
import { changedDependencyState, readDependencySnapshot } from "./core/dependency-state.ts";
import { captureRepairChanges, sameRepairChanges } from "./core/git.ts";
import { isRecord } from "./core/json.ts";
import { readRepairPayload } from "./core/repair-payload.ts";
import { readRunContext } from "./core/run-context.ts";
import { initialRecord, readRunRecord, writeRunRecord, type RunRecord } from "./core/status.ts";
import { cleanReportText, linkifyRepoPaths, repoFileUrl } from "./core/text.ts";
import { required } from "./shared/env.ts";
import { github, object } from "./shared/github-api.ts";
import { REPO } from "./shared/target.ts";

const REPORT_MARKER = "<!-- depvisor-v2-report -->";
const MAX_COMMENT_CHARS = 60_000;

type Json = Record<string, unknown>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifySnapshotFiles(contextFile: string): ReturnType<typeof readRunContext> {
  const context = readRunContext(contextFile);
  if (sha256(JSON.stringify(context)) !== required("DEPVISOR_CONTEXT_SHA")) {
    throw new Error("The token-free run context changed after it was prepared");
  }
  const snapshotText = readFileSync(context.dependencySnapshotFile);
  if (sha256(snapshotText) !== required("DEPVISOR_SNAPSHOT_SHA")) {
    throw new Error("The dependency-state snapshot changed after it was prepared");
  }
  return context;
}

function secureGitEnv(home: string, token = ""): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C.UTF-8",
  };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}

function git(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status ?? 1}): ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return (result.stdout || "").trim();
}

function applyRepair(
  clone: string,
  env: NodeJS.ProcessEnv,
  changes: ReturnType<typeof captureRepairChanges>,
): void {
  if (changes.patch)
    git(clone, env, ["apply", "--binary", "--whitespace=nowarn", "-"], changes.patch);
  materializeNewRepairFiles(clone, changes.newFiles);
}

function serverUrl(): string {
  const server = (process.env.DEPVISOR_SERVER_URL || "https://github.com").replace(/\/$/, "");
  if (!/^https:\/\/[A-Za-z0-9._-]+(?::\d+)?$/.test(server)) {
    throw new Error("Refusing an invalid GitHub server URL");
  }
  return server;
}

function publishCommit(
  repository: string,
  headRef: string,
  headSha: string,
  changes: ReturnType<typeof captureRepairChanges>,
): string {
  if (repository !== required("DEPVISOR_REPOSITORY")) {
    throw new Error("Refusing to push outside the workflow repository");
  }
  const server = serverUrl();
  const root = mkdtempSync(join(tmpdir(), "depvisor-v2-publish-"));
  const home = join(root, "home");
  const clone = join(root, "repo");
  mkdirSync(home);
  const env = secureGitEnv(home, required("GH_TOKEN"));
  try {
    git(root, env, ["clone", "--quiet", "--no-checkout", `${server}/${repository}.git`, clone]);
    git(clone, env, ["checkout", "--quiet", "--detach", headSha]);
    git(clone, env, ["check-ref-format", "--branch", headRef]);
    applyRepair(clone, env, changes);
    git(clone, env, ["add", "--all"]);
    const staged = git(clone, env, ["diff", "--cached", "--name-only"]);
    if (!staged) throw new Error("The captured repair produced no changes in a clean clone");
    git(clone, env, [
      "-c",
      "user.name=depvisor",
      "-c",
      "user.email=depvisor[bot]@users.noreply.github.com",
      "-c",
      "author.name=github-actions[bot]",
      "-c",
      "author.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "--quiet",
      "--message",
      "fix(deps): repair dependency update",
      "--author",
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    ]);
    const commitSha = git(clone, env, ["rev-parse", "HEAD"]);
    git(clone, env, [
      "push",
      "--quiet",
      `--force-with-lease=refs/heads/${headRef}:${headSha}`,
      "origin",
      `HEAD:refs/heads/${headRef}`,
    ]);
    return commitSha;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function evidenceLink(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return ` ([source](${url.href.replaceAll(")", "%29")}))`;
  } catch {
    return "";
  }
}

function bullets(
  items: readonly string[],
  empty: string,
  render: (value: string) => string,
): string {
  return items.length > 0 ? items.map((item) => `- ${render(item)}`).join("\n") : `- ${empty}`;
}

/**
 * A mention becomes a link only when the file exists at the commit the link
 * pins. The verified working tree carries exactly the published repair
 * commit's content; without a repair the link pins the snapshotted head, whose
 * tree may differ from an unpublished (deferred) working tree.
 */
function linkedFileExists(repaired: boolean, headSha: string, path: string): boolean {
  if (repaired) {
    try {
      return statSync(join(REPO, path)).isFile();
    } catch {
      return false;
    }
  }
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "cat-file", "-t", `${headSha}:${path}`],
    { cwd: REPO, encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "blob";
}

function reportBody(
  payload: ReturnType<typeof readRepairPayload>,
  context: ReturnType<typeof readRunContext>,
  commitSha: string | null,
): string {
  const agent = payload.agent;
  const server = serverUrl();
  const linkSha = commitSha ?? context.pullRequest.headSha;
  const fileUrl = (path: string): string | null =>
    linkedFileExists(commitSha !== null, context.pullRequest.headSha, path)
      ? repoFileUrl(server, payload.repository, linkSha, path)
      : null;
  const prose = (value: string, max?: number): string =>
    linkifyRepoPaths(cleanReportText(value, max), fileUrl);
  const upstream =
    agent.upstream_changes.length > 0
      ? agent.upstream_changes
          .map(
            (item) =>
              `- **${cleanReportText(item.dependency, 200)}:** ${prose(item.change)} ` +
              `_${prose(item.relevance)}_${evidenceLink(item.evidence_url)}`,
          )
          .join("\n")
      : "- No repository-relevant upstream change stood out from the available evidence.";
  const verification =
    agent.verification.length > 0
      ? agent.verification
          .map(
            (item) =>
              `- \`${cleanReportText(item.command, 500).replaceAll("`", "\\`")}\` — **${item.outcome}**: ` +
              prose(item.evidence),
          )
          .join("\n")
      : "- No local verification result was available.";
  const heading =
    agent.verdict === "defer"
      ? "Depvisor deferred this update"
      : commitSha
        ? "Depvisor published a repair"
        : "Depvisor reviewed this update";
  const body = `${REPORT_MARKER}
## ${heading}

${prose(agent.summary)}

### Relevant upstream changes

${upstream}

### Repair

${bullets(agent.changes_made, commitSha ? "The repair commit contains the working-tree changes listed above." : "No code repair was needed.", prose)}
${commitSha ? `\nRepair commit: \`${commitSha}\`` : ""}

### Verification evidence

${verification}

### Residual risks

${bullets(agent.risks, "No additional repository-specific risk was identified.", prose)}
${agent.verdict === "defer" ? `\n**Why depvisor deferred:** ${prose(agent.defer_reason || "No safe bounded repair was found.")}` : ""}

Initial CI: **${cleanReportText(context.trigger.conclusion, 100)}**${context.trigger.url ? ` — ${cleanReportText(context.trigger.workflowName || "workflow run", 200)}${evidenceLink(context.trigger.url)}` : ""}.

_Generated from the updater diff, repository inspection, upstream sources, and the command evidence shown above. Review before merging._`;
  return body.slice(0, MAX_COMMENT_CHARS);
}

async function upsertComment(repository: string, prNumber: number, body: string): Promise<string> {
  const comments: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(
      `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid PR comment list");
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  let existing: Json | undefined;
  for (const value of comments.toReversed()) {
    if (isRecord(value) && typeof value.body === "string" && value.body.includes(REPORT_MARKER)) {
      existing = value;
      break;
    }
  }
  const response = existing
    ? await github(`/repos/${repository}/issues/comments/${String(existing.id)}`, {
        method: "PATCH",
        body: { body },
      })
    : await github(`/repos/${repository}/issues/${prNumber}/comments`, {
        method: "POST",
        body: { body },
      });
  const comment = object(response, "comment");
  return typeof comment.html_url === "string" ? comment.html_url : "";
}

async function main(): Promise<void> {
  const statusFile = required("DEPVISOR_STATUS_FILE");
  const previous =
    readRunRecord(statusFile) || initialRecord("publish-failed", "Missing run status.");
  let commitSha: string | null = null;
  try {
    const context = verifySnapshotFiles(required("DEPVISOR_CONTEXT_FILE"));
    const payload = readRepairPayload(required("DEPVISOR_PAYLOAD_FILE"));
    if (
      payload.repository !== context.repository ||
      payload.prNumber !== context.pullRequest.number ||
      payload.headSha !== context.pullRequest.headSha ||
      payload.headRef !== context.pullRequest.headRef ||
      payload.headRepository !== context.repository
    ) {
      throw new Error("The repair payload does not match the prepared updater PR");
    }
    const pr = object(
      await github(`/repos/${payload.repository}/pulls/${payload.prNumber}`),
      "pull request",
    );
    const currentHead = object(pr.head, "PR head");
    const currentHeadRepository = object(currentHead.repo, "PR head repository");
    if (
      pr.state !== "open" ||
      currentHead.sha !== payload.headSha ||
      currentHead.ref !== payload.headRef ||
      currentHeadRepository.full_name !== payload.repository
    ) {
      const record: RunRecord = {
        ...previous,
        status: "stale-pr",
        summary:
          "The updater PR changed or closed while depvisor was working; nothing was published.",
      };
      writeRunRecord(statusFile, record);
      return;
    }

    const snapshot = readDependencySnapshot(context.dependencySnapshotFile);
    const dependencyChanges = changedDependencyState(REPO, snapshot);
    if (dependencyChanges.length > 0) {
      throw new Error(`Dependency state changed: ${dependencyChanges.join(", ")}`);
    }
    const liveChanges = captureRepairChanges(REPO);
    if (!sameRepairChanges(liveChanges, payload.changes)) {
      throw new Error("The working-tree repair changed after the agent result was captured");
    }

    if (payload.agent.verdict === "ready" && liveChanges.paths.length > 0) {
      commitSha = publishCommit(
        payload.headRepository,
        payload.headRef,
        payload.headSha,
        liveChanges,
      );
    }
    const commentUrl = await upsertComment(
      payload.repository,
      payload.prNumber,
      reportBody(payload, context, commitSha),
    );
    const status =
      payload.agent.verdict === "defer" ? "deferred" : commitSha ? "repair-published" : "reviewed";
    writeRunRecord(statusFile, {
      ...previous,
      status,
      summary:
        status === "deferred"
          ? payload.agent.defer_reason || payload.agent.summary
          : status === "repair-published"
            ? "Published one repair commit to the existing updater PR and posted the reviewer report."
            : "The updater PR required no repair; posted the reviewer report.",
      repaired: commitSha !== null,
      commitSha,
      commentUrl: commentUrl || null,
      changedFiles: liveChanges.paths,
    });
  } catch (error: unknown) {
    writeRunRecord(statusFile, {
      ...previous,
      status: String(error).includes("Dependency state")
        ? "dependency-state-changed"
        : "publish-failed",
      summary: `Nothing further was published: ${String(error)}`,
      commitSha,
    });
    console.error(`::error::depvisor publication failed: ${String(error)}`);
    process.exitCode = 1;
  }
}

await main();
