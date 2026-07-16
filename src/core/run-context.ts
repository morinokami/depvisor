/** Trusted, token-free handoff from the GitHub snapshot step to the agent. */

import { readFileSync } from "node:fs";

export interface PullRequestFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface FailedJob {
  name: string;
  conclusion: string;
  htmlUrl: string;
  steps: Array<{ name: string; conclusion: string | null; number: number }>;
  log: string;
}

export interface RunContext {
  version: 2;
  repository: string;
  pullRequest: {
    number: number;
    url: string;
    title: string;
    body: string;
    author: string;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    headRepository: string;
  };
  trigger: {
    event: string;
    workflowRunId: number | null;
    workflowName: string;
    conclusion: string;
    url: string;
  };
  changedFiles: PullRequestFile[];
  failedJobs: FailedJob[];
  dependencySnapshotFile: string;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid run context: ${field}`);
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid run context: ${field}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid run context: ${field}`);
  }
  return value;
}

function pullRequestFile(value: unknown): PullRequestFile {
  const file = record(value, "changedFiles[]");
  const parsed: PullRequestFile = {
    filename: string(file.filename, "changedFiles[].filename"),
    status: string(file.status, "changedFiles[].status"),
    additions: number(file.additions, "changedFiles[].additions"),
    deletions: number(file.deletions, "changedFiles[].deletions"),
  };
  if (typeof file.previousFilename === "string") parsed.previousFilename = file.previousFilename;
  if (typeof file.patch === "string") parsed.patch = file.patch;
  return parsed;
}

function failedJob(value: unknown): FailedJob {
  const job = record(value, "failedJobs[]");
  if (!Array.isArray(job.steps)) throw new Error("Invalid run context: failedJobs[].steps");
  return {
    name: string(job.name, "failedJobs[].name"),
    conclusion: string(job.conclusion, "failedJobs[].conclusion"),
    htmlUrl: string(job.htmlUrl, "failedJobs[].htmlUrl"),
    steps: job.steps.map((rawStep) => {
      const step = record(rawStep, "failedJobs[].steps[]");
      return {
        name: string(step.name, "failedJobs[].steps[].name"),
        conclusion:
          step.conclusion === null
            ? null
            : string(step.conclusion, "failedJobs[].steps[].conclusion"),
        number: number(step.number, "failedJobs[].steps[].number"),
      };
    }),
    log: string(job.log, "failedJobs[].log"),
  };
}

/** Minimal fail-closed parser; the snapshot file is outside the target checkout. */
export function readRunContext(path: string): RunContext {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const root = record(raw, "root");
  if (root.version !== 2) throw new Error("Unsupported run context version");
  const pr = record(root.pullRequest, "pullRequest");
  const trigger = record(root.trigger, "trigger");
  if (!Array.isArray(root.changedFiles) || !Array.isArray(root.failedJobs)) {
    throw new Error("Incomplete run context");
  }
  return {
    version: 2,
    repository: string(root.repository, "repository"),
    pullRequest: {
      number: number(pr.number, "pullRequest.number"),
      url: string(pr.url, "pullRequest.url"),
      title: string(pr.title, "pullRequest.title"),
      body: string(pr.body, "pullRequest.body"),
      author: string(pr.author, "pullRequest.author"),
      baseRef: string(pr.baseRef, "pullRequest.baseRef"),
      baseSha: string(pr.baseSha, "pullRequest.baseSha"),
      headRef: string(pr.headRef, "pullRequest.headRef"),
      headSha: string(pr.headSha, "pullRequest.headSha"),
      headRepository: string(pr.headRepository, "pullRequest.headRepository"),
    },
    trigger: {
      event: string(trigger.event, "trigger.event"),
      workflowRunId:
        trigger.workflowRunId === null
          ? null
          : number(trigger.workflowRunId, "trigger.workflowRunId"),
      workflowName: string(trigger.workflowName, "trigger.workflowName"),
      conclusion: string(trigger.conclusion, "trigger.conclusion"),
      url: string(trigger.url, "trigger.url"),
    },
    changedFiles: root.changedFiles.map(pullRequestFile),
    failedJobs: root.failedJobs.map(failedJob),
    dependencySnapshotFile: string(root.dependencySnapshotFile, "dependencySnapshotFile"),
  };
}

export function isSupportedUpdater(author: string): boolean {
  const login = author.toLowerCase();
  return login === "dependabot[bot]" || login === "renovate[bot]" || login === "renovate-bot";
}
