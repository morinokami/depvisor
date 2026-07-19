/**
 * Token-holding, read-only GitHub snapshot step for one updater PR.
 * Runs before the local-sandbox agent and writes a token-free context file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MAX_PATCH_CHARS, MAX_TOTAL_PATCH_CHARS, takeText } from "./core/context-budget.ts";
import { snapshotDependencyState } from "./core/dependency-state.ts";
import { headSha as currentHeadSha } from "./core/git.ts";
import { int, isRecord, str } from "./core/json.ts";
import { collectPages } from "./core/pagination.ts";
import { isSafeRepoPath } from "./core/paths.ts";
import { REPORT_MARKER, generatorName, parseReportState } from "./core/report-state.ts";
import {
  isSupportedUpdater,
  type FailedJob,
  type PullRequestFile,
  type RunContext,
} from "./core/run-context.ts";
import { initialRecord, writeRunRecord } from "./core/status.ts";
import { writeOutput as output } from "./shared/actions.ts";
import { required } from "./shared/env.ts";
import { downloadJobLog, github, latestMarkerComment, object } from "./shared/github-api.ts";
import { REPO } from "./shared/target.ts";

const MAX_JOB_LOG_CHARS = 60_000;
const MAX_TOTAL_LOG_CHARS = 180_000;
const MAX_JOB_PAGES = 30;
const MAX_FILE_PAGES = 30;

async function resolvePullRequestNumber(repository: string, runId: number | null): Promise<number> {
  const configured = Number(process.env.DEPVISOR_PR_NUMBER || "");
  if (Number.isSafeInteger(configured) && configured > 0) return configured;

  if (runId !== null) {
    const run = object(await github(`/repos/${repository}/actions/runs/${runId}`), "workflow run");
    const prs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    const first = prs[0];
    if (isRecord(first)) {
      const number = int(first.number);
      if (number > 0) return number;
    }
  }

  const headSha = process.env.DEPVISOR_HEAD_SHA?.trim();
  if (headSha) {
    const associated = await github(`/repos/${repository}/commits/${headSha}/pulls`);
    if (Array.isArray(associated)) {
      const open = associated.find((value) => isRecord(value) && value.state === "open");
      if (isRecord(open)) {
        const number = int(open.number);
        if (number > 0) return number;
      }
    }
  }
  throw new Error("Could not resolve an open pull request for this workflow run");
}

async function pullRequestFiles(repository: string, number: number): Promise<PullRequestFile[]> {
  const raw = await collectPages(
    async (page) => {
      const batch = await github(
        `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid PR file list");
      return batch;
    },
    { pageSize: 100, maxPages: MAX_FILE_PAGES, label: "PR file list" },
  );
  const files: PullRequestFile[] = [];
  const patchBudget = { remaining: MAX_TOTAL_PATCH_CHARS };
  for (const value of raw) {
    const file = object(value, "PR file");
    const filename = str(file.filename);
    if (!isSafeRepoPath(filename)) throw new Error("GitHub returned an unsafe PR path");
    const entry: PullRequestFile = {
      filename,
      status: str(file.status),
      additions: int(file.additions),
      deletions: int(file.deletions),
    };
    const previous = str(file.previous_filename);
    if (previous) {
      if (!isSafeRepoPath(previous)) {
        throw new Error("GitHub returned an unsafe previous PR path");
      }
      entry.previousFilename = previous;
    }
    const patch = str(file.patch);
    if (patch && patchBudget.remaining > 0) {
      entry.patch = takeText(patch, MAX_PATCH_CHARS, patchBudget);
    }
    files.push(entry);
  }
  return files;
}

async function failedJobs(repository: string, runId: number | null): Promise<FailedJob[]> {
  if (runId === null) return [];
  const jobs = await collectPages(
    async (page) => {
      const raw = object(
        await github(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`),
        "workflow jobs",
      );
      if (!Array.isArray(raw.jobs)) throw new Error("GitHub returned an invalid workflow job list");
      return raw.jobs;
    },
    { pageSize: 100, maxPages: MAX_JOB_PAGES, label: "Workflow job list" },
  );
  const failed = jobs.filter((value) => {
    if (!isRecord(value)) return false;
    const conclusion = str(value.conclusion);
    return conclusion !== "success" && conclusion !== "skipped" && conclusion !== "neutral";
  });
  let remaining = MAX_TOTAL_LOG_CHARS;
  const result: FailedJob[] = [];
  for (const value of failed) {
    const job = object(value, "workflow job");
    const id = int(job.id);
    let downloaded = "";
    if (id > 0 && remaining > 0) {
      try {
        downloaded = await downloadJobLog(repository, id, MAX_JOB_LOG_CHARS);
      } catch (error: unknown) {
        downloaded = `(job log unavailable: ${String(error)})`;
      }
    }
    const log = downloaded.slice(-remaining);
    remaining -= log.length;
    const steps = Array.isArray(job.steps)
      ? job.steps.map((rawStep) => {
          const step = object(rawStep, "workflow step");
          const conclusion = step.conclusion;
          return {
            name: str(step.name),
            conclusion: typeof conclusion === "string" ? conclusion : null,
            number: int(step.number),
          };
        })
      : [];
    result.push({
      name: str(job.name),
      conclusion: str(job.conclusion),
      htmlUrl: str(job.html_url),
      steps,
      log,
    });
  }
  return result;
}

async function main(): Promise<void> {
  const repository = required("DEPVISOR_REPOSITORY");
  const runDir = required("DEPVISOR_RUN_DIR");
  const statusFile = required("DEPVISOR_STATUS_FILE");
  const contextFile = required("DEPVISOR_CONTEXT_FILE");
  mkdirSync(runDir, { recursive: true });
  const workflowRunIdRaw = Number(process.env.DEPVISOR_WORKFLOW_RUN_ID || "");
  const workflowRunId =
    Number.isSafeInteger(workflowRunIdRaw) && workflowRunIdRaw > 0 ? workflowRunIdRaw : null;
  const number = await resolvePullRequestNumber(repository, workflowRunId);
  const rawPr = object(await github(`/repos/${repository}/pulls/${number}`), "pull request");
  const user = object(rawPr.user, "PR author");
  const head = object(rawPr.head, "PR head");
  const base = object(rawPr.base, "PR base");
  const headRepo = object(head.repo, "PR head repository");
  const author = str(user.login);
  const prUrl = str(rawPr.html_url);

  if (
    rawPr.state !== "open" ||
    !isSupportedUpdater(author) ||
    str(headRepo.full_name) !== repository
  ) {
    writeRunRecord(
      statusFile,
      initialRecord(
        "unsupported-pr",
        "depvisor only processes open Dependabot/Renovate PRs whose branch belongs to this repository.",
        prUrl,
      ),
    );
    output("processable", "false");
    output("pr_url", prUrl);
    return;
  }

  const headSha = str(head.sha);
  if (!/^[0-9a-f]{40}$/.test(headSha) || currentHeadSha(REPO) !== headSha) {
    writeRunRecord(
      statusFile,
      initialRecord(
        "wrong-head",
        `The checkout is not the current head of PR #${number}; check out the workflow_run head_sha before invoking depvisor.`,
        prUrl,
      ),
    );
    output("processable", "false");
    output("pr_url", prUrl);
    return;
  }

  // The maintained comment records which head a no-repair review covered. The
  // comment is editable, so the recorded state is trusted only to skip a
  // duplicate review of a green head under the same depvisor version — a
  // missing, forged, or stale line simply falls through to a full run, and a
  // non-success CI conclusion never skips.
  if ((process.env.DEPVISOR_WORKFLOW_CONCLUSION || "") === "success") {
    const existing = await latestMarkerComment(repository, number, REPORT_MARKER);
    const state = existing === null ? null : parseReportState(existing.body);
    if (
      existing !== null &&
      state !== null &&
      state.headSha === headSha &&
      state.conclusion === "success" &&
      state.generator === generatorName()
    ) {
      writeRunRecord(statusFile, {
        ...initialRecord(
          "already-reviewed",
          `The report comment already covers PR #${number} head ${headSha} on a green CI run; skipped a duplicate review.`,
          prUrl,
        ),
        commentUrl: existing.htmlUrl || null,
      });
      output("processable", "false");
      output("pr_url", prUrl);
      return;
    }
  }

  const changedFiles = await pullRequestFiles(repository, number);
  const dependencySnapshotFile = join(runDir, "dependency-state.json");
  const updaterPaths = changedFiles.flatMap((file) =>
    file.previousFilename ? [file.filename, file.previousFilename] : [file.filename],
  );
  const dependencySnapshotText = JSON.stringify(
    snapshotDependencyState(REPO, updaterPaths),
    null,
    2,
  );
  writeFileSync(dependencySnapshotFile, dependencySnapshotText);

  const context: RunContext = {
    version: 2,
    repository,
    pullRequest: {
      number,
      url: prUrl,
      title: str(rawPr.title),
      body: str(rawPr.body),
      author,
      baseRef: str(base.ref),
      baseSha: str(base.sha),
      headRef: str(head.ref),
      headSha,
      headRepository: str(headRepo.full_name),
    },
    trigger: {
      event: process.env.DEPVISOR_EVENT_NAME || "",
      workflowRunId,
      workflowName: process.env.DEPVISOR_WORKFLOW_NAME || "",
      conclusion: process.env.DEPVISOR_WORKFLOW_CONCLUSION || "unknown",
      url: process.env.DEPVISOR_WORKFLOW_URL || "",
    },
    changedFiles,
    failedJobs: await failedJobs(repository, workflowRunId),
    dependencySnapshotFile,
  };
  writeFileSync(contextFile, JSON.stringify(context, null, 2));
  const contextSha = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  writeRunRecord(
    statusFile,
    initialRecord("in-progress", `depvisor is reviewing updater PR #${number}.`, prUrl),
  );
  output("processable", "true");
  output("context_sha", contextSha);
  output("snapshot_sha", createHash("sha256").update(dependencySnapshotText).digest("hex"));
  output("pr_url", prUrl);
}

main().catch((error: unknown) => {
  console.error(`::error::depvisor could not prepare the updater PR: ${String(error)}`);
  process.exitCode = 1;
});
