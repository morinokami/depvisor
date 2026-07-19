/**
 * Token-holding publication boundary for v2.
 *
 * The agent never receives GH_TOKEN. This step rechecks the frozen files,
 * current PR head, and captured working-tree fix, then creates at most one
 * commit on the existing updater branch and creates/updates one marker comment.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeNewFixFiles } from "./core/apply-fix.ts";
import { changedFrozenFiles, readFrozenFilesSnapshot } from "./core/frozen-files.ts";
import { captureFixChanges, sameFixChanges, treeBlobPaths } from "./core/git.ts";
import { readFixPayload } from "./core/fix-payload.ts";
import { renderReportBody } from "./core/report-body.ts";
import { REPORT_MARKER } from "./core/report-state.ts";
import { readRunContext } from "./core/run-context.ts";
import { initialRecord, readRunRecord, writeRunRecord, type RunRecord } from "./core/status.ts";
import { tempDir } from "./core/temp.ts";
import { actionsRunUrl } from "./core/text.ts";
import { required } from "./shared/env.ts";
import { github, latestMarkerComment, object, serverUrl } from "./shared/github-api.ts";
import { REPO } from "./shared/target.ts";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifySnapshotFiles(contextFile: string): ReturnType<typeof readRunContext> {
  const context = readRunContext(contextFile);
  if (sha256(JSON.stringify(context)) !== required("DEPVISOR_CONTEXT_SHA")) {
    throw new Error("The token-free run context changed after it was prepared");
  }
  const snapshotText = readFileSync(context.frozenFilesSnapshotFile);
  if (sha256(snapshotText) !== required("DEPVISOR_SNAPSHOT_SHA")) {
    throw new Error("The frozen-files snapshot changed after it was prepared");
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

function applyFix(
  clone: string,
  env: NodeJS.ProcessEnv,
  changes: ReturnType<typeof captureFixChanges>,
): void {
  if (changes.patch)
    git(clone, env, ["apply", "--binary", "--whitespace=nowarn", "-"], changes.patch);
  writeNewFixFiles(clone, changes.newFiles);
}

interface PublishedCommit {
  sha: string;
  blobPaths: Set<string>;
}

function publishCommit(
  repository: string,
  headRef: string,
  headSha: string,
  changes: ReturnType<typeof captureFixChanges>,
): PublishedCommit {
  if (repository !== required("DEPVISOR_REPOSITORY")) {
    throw new Error("Refusing to push outside the workflow repository");
  }
  const server = serverUrl();
  using root = tempDir("depvisor-v2-publish-");
  const home = join(root.path, "home");
  const clone = join(root.path, "repo");
  mkdirSync(home);
  const env = secureGitEnv(home, required("GH_TOKEN"));
  git(root.path, env, ["clone", "--quiet", "--no-checkout", `${server}/${repository}.git`, clone]);
  git(clone, env, ["checkout", "--quiet", "--detach", headSha]);
  git(clone, env, ["check-ref-format", "--branch", headRef]);
  applyFix(clone, env, changes);
  git(clone, env, ["add", "--all"]);
  const staged = git(clone, env, ["diff", "--cached", "--name-only"]);
  if (!staged) throw new Error("The captured fix produced no changes in a fresh clone");
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
    "fix(deps): adapt to dependency update",
    "--author",
    "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  ]);
  const commitSha = git(clone, env, ["rev-parse", "HEAD"]);
  // The report links files at this exact commit; read its tree before the clone goes away.
  const blobPaths = treeBlobPaths(clone, commitSha);
  git(clone, env, [
    "push",
    "--quiet",
    `--force-with-lease=refs/heads/${headRef}:${headSha}`,
    "origin",
    `HEAD:refs/heads/${headRef}`,
  ]);
  return { sha: commitSha, blobPaths };
}

/**
 * Link the report footer to the Actions run that wrote it. Every component is
 * workflow-derived and shape-checked by the shared builder; a missing or
 * malformed value renders an unlinked footer rather than a loosely built URL.
 */
function reportRunUrl(): string | null {
  const repository = process.env.DEPVISOR_REPOSITORY?.trim() ?? "";
  const runId = Number(process.env.DEPVISOR_RUN_ID?.trim() || "");
  return actionsRunUrl(serverUrl(), repository, runId);
}

async function upsertComment(repository: string, prNumber: number, body: string): Promise<string> {
  const existing = await latestMarkerComment(repository, prNumber, REPORT_MARKER);
  const response = existing
    ? await github(`/repos/${repository}/issues/comments/${existing.id}`, {
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

/**
 * Refusal to publish over changed frozen files. The catch block maps
 * this — and only this — failure to the dedicated frozen-files-changed
 * status, so the classification must not hang on error-message wording.
 */
class FrozenFilesChangedError extends Error {}

async function main(): Promise<void> {
  const statusFile = required("DEPVISOR_STATUS_FILE");
  const previous =
    readRunRecord(statusFile) || initialRecord("publish-failed", "Missing run status.");
  let commitSha: string | null = null;
  try {
    const context = verifySnapshotFiles(required("DEPVISOR_CONTEXT_FILE"));
    const payload = readFixPayload(required("DEPVISOR_PAYLOAD_FILE"));
    if (
      payload.repository !== context.repository ||
      payload.prNumber !== context.pullRequest.number ||
      payload.headSha !== context.pullRequest.headSha ||
      payload.headRef !== context.pullRequest.headRef ||
      payload.headRepository !== context.repository
    ) {
      throw new Error("The fix payload does not match the prepared updater PR");
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
        fixPushed: false,
      };
      writeRunRecord(statusFile, record);
      return;
    }

    const snapshot = readFrozenFilesSnapshot(context.frozenFilesSnapshotFile);
    const frozenChanges = changedFrozenFiles(REPO, snapshot);
    if (frozenChanges.length > 0) {
      throw new FrozenFilesChangedError(`Frozen files changed: ${frozenChanges.join(", ")}`);
    }
    const liveChanges = captureFixChanges(REPO);
    if (!sameFixChanges(liveChanges, payload.changes)) {
      throw new Error("The working-tree fix changed after the agent result was captured");
    }

    let published: PublishedCommit | null = null;
    if (payload.agent.verdict === "ready" && liveChanges.paths.length > 0) {
      published = publishCommit(
        payload.headRepository,
        payload.headRef,
        payload.headSha,
        liveChanges,
      );
      commitSha = published.sha;
    }
    // Without a fix the links pin the snapshotted head, whose tree may differ
    // from an unpublished (deferred) working tree — so enumerate the commit, not the files.
    const blobPaths = published?.blobPaths ?? treeBlobPaths(REPO, context.pullRequest.headSha);
    const commentUrl = await upsertComment(
      payload.repository,
      payload.prNumber,
      renderReportBody(payload, context, {
        commitSha,
        blobPaths,
        server: serverUrl(),
        runUrl: reportRunUrl(),
      }),
    );
    const status =
      payload.agent.verdict === "defer" ? "deferred" : commitSha ? "fix-pushed" : "reviewed";
    writeRunRecord(statusFile, {
      ...previous,
      status,
      summary:
        status === "deferred"
          ? payload.agent.defer_reason || payload.agent.summary
          : status === "fix-pushed"
            ? "Pushed one fix commit to the existing updater PR and posted the reviewer report."
            : "The updater PR required no fix; posted the reviewer report.",
      fixPushed: commitSha !== null,
      commitSha,
      commentUrl: commentUrl || null,
      changedFiles: liveChanges.paths,
    });
  } catch (error: unknown) {
    writeRunRecord(statusFile, {
      ...previous,
      status: error instanceof FrozenFilesChangedError ? "frozen-files-changed" : "publish-failed",
      summary: `Nothing further was published: ${String(error)}`,
      // A failure after publishCommit returned still pushed a commit; report
      // exactly what reached the branch.
      fixPushed: commitSha !== null,
      commitSha,
    });
    console.error(`::error::depvisor publication failed: ${String(error)}`);
    process.exitCode = 1;
  }
}

await main();
