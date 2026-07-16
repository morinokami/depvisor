/**
 * Token-holding, read-only GitHub snapshot step for one updater PR.
 * Runs before the local-sandbox agent and writes a token-free context file.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { snapshotDependencyState } from "./core/dependency-state.ts";
import {
  isSupportedUpdater,
  type FailedJob,
  type PullRequestFile,
  type RunContext,
} from "./core/run-context.ts";
import { initialRecord, writeRunRecord } from "./core/status.ts";
import { REPO } from "./shared/target.ts";

const MAX_PATCH_CHARS = 16_000;
const MAX_JOB_LOG_CHARS = 60_000;
const MAX_TOTAL_LOG_CHARS = 180_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function output(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

function apiBase(): string {
  return (process.env.DEPVISOR_API_URL || "https://api.github.com").replace(/\/$/, "");
}

async function github(path: string): Promise<unknown> {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      "User-Agent": "depvisor-v2",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
  return response.json();
}

function object(value: unknown, label: string): Json {
  if (!isObject(value)) {
    throw new Error(`GitHub returned an invalid ${label}`);
  }
  return value;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function validPath(path: string): boolean {
  return (
    path !== "" && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\")
  );
}

async function resolvePullRequestNumber(repository: string, runId: number | null): Promise<number> {
  const configured = Number(process.env.DEPVISOR_PR_NUMBER || "");
  if (Number.isSafeInteger(configured) && configured > 0) return configured;

  if (runId !== null) {
    const run = object(await github(`/repos/${repository}/actions/runs/${runId}`), "workflow run");
    const prs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    const first = prs[0];
    if (isObject(first)) {
      const number = int(first.number);
      if (number > 0) return number;
    }
  }

  const headSha = process.env.DEPVISOR_HEAD_SHA?.trim();
  if (headSha) {
    const associated = await github(`/repos/${repository}/commits/${headSha}/pulls`);
    if (Array.isArray(associated)) {
      const open = associated.find((value) => isObject(value) && value.state === "open");
      if (isObject(open)) {
        const number = int(open.number);
        if (number > 0) return number;
      }
    }
  }
  throw new Error("Could not resolve an open pull request for this workflow run");
}

async function pullRequestFiles(repository: string, number: number): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const raw = await github(
      `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(raw)) throw new Error("GitHub returned an invalid PR file list");
    for (const value of raw) {
      const file = object(value, "PR file");
      const filename = str(file.filename);
      if (!validPath(filename)) throw new Error("GitHub returned an unsafe PR path");
      const entry: PullRequestFile = {
        filename,
        status: str(file.status),
        additions: int(file.additions),
        deletions: int(file.deletions),
      };
      const previous = str(file.previous_filename);
      if (previous) {
        if (!validPath(previous)) throw new Error("GitHub returned an unsafe previous PR path");
        entry.previousFilename = previous;
      }
      const patch = str(file.patch);
      if (patch) entry.patch = patch.slice(0, MAX_PATCH_CHARS);
      files.push(entry);
    }
    if (raw.length < 100) return files;
  }
  throw new Error("PR file list exceeded depvisor's 3,000-file snapshot limit");
}

async function jobLog(repository: string, jobId: number): Promise<string> {
  const first = await fetch(`${apiBase()}/repos/${repository}/actions/jobs/${jobId}/logs`, {
    redirect: "manual",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      "User-Agent": "depvisor-v2",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) return "(job log redirect had no location)";
    const response = await fetch(location);
    if (!response.ok) return `(job log download returned ${response.status})`;
    return (await response.text()).slice(-MAX_JOB_LOG_CHARS);
  }
  if (!first.ok) return `(job log unavailable: ${first.status})`;
  return (await first.text()).slice(-MAX_JOB_LOG_CHARS);
}

async function failedJobs(repository: string, runId: number | null): Promise<FailedJob[]> {
  if (runId === null) return [];
  const raw = object(
    await github(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`),
    "workflow jobs",
  );
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  const failed = jobs.filter((value) => {
    if (!isObject(value)) return false;
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
        downloaded = await jobLog(repository, id);
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

function currentHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const repository = required("DEPVISOR_REPOSITORY");
  const runDir = required("DEPVISOR_RUN_DIR");
  const statusFile = required("DEPVISOR_STATUS_FILE");
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
  if (!/^[0-9a-f]{40}$/.test(headSha) || currentHead() !== headSha) {
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
  const contextFile = join(runDir, "context.json");
  writeFileSync(contextFile, JSON.stringify(context, null, 2));
  const contextSha = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  writeRunRecord(
    statusFile,
    initialRecord("in-progress", `depvisor is reviewing updater PR #${number}.`, prUrl),
  );
  output("processable", "true");
  output("context_file", contextFile);
  output("context_sha", contextSha);
  output("snapshot_sha", createHash("sha256").update(dependencySnapshotText).digest("hex"));
  output("pr_url", prUrl);
}

main().catch((error: unknown) => {
  console.error(`::error::depvisor could not prepare the updater PR: ${String(error)}`);
  process.exitCode = 1;
});
