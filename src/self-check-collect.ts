/**
 * Token-holding, read-only collector for the weekly self-check. Summarizes the
 * recent depvisor development-workflow runs (conclusions, durations, parsed
 * outputs echo, bounded failure-log tails) plus existing self-check issue
 * titles into one token-free envelope for the sandbox-less analyst agent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./core/json.ts";
import { collectPages } from "./core/pagination.ts";
import { SELF_CHECK_LABEL, parseOutputsLine, type ParsedRunOutputs } from "./core/self-check.ts";
import { writeOutput } from "./shared/actions.ts";
import { required } from "./shared/env.ts";
import { downloadJobLog, github, object } from "./shared/github-api.ts";

const WINDOW_DAYS = 7;
const MAX_RUNS = 50;
const MAX_RUN_PAGES = 3;
const MAX_JOBS_PER_RUN = 10;
const JOB_LOG_TAIL_CHARS = 60_000;
const MAX_FAILURE_EXCERPT_CHARS = 15_000;
const MAX_TOTAL_FAILURE_CHARS = 120_000;
const MAX_EXISTING_ISSUES = 50;

interface RunSummary {
  id: number;
  event: string;
  conclusion: string;
  headBranch: string;
  htmlUrl: string;
  createdAt: string;
  attempt: number;
  durationSeconds: number | null;
  outputs: ParsedRunOutputs | null;
  failureExcerpt?: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function durationSeconds(startedAt: string, updatedAt: string): number | null {
  const started = Date.parse(startedAt);
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(updated) || updated < started) return null;
  return Math.round((updated - started) / 1_000);
}

async function recentRuns(repository: string): Promise<{ runs: unknown[]; truncated: boolean }> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  const created = encodeURIComponent(`>=${since}`);
  const runs = await collectPages(
    async (page) => {
      const raw = object(
        await github(
          `/repos/${repository}/actions/workflows/depvisor.yml/runs?per_page=100&page=${page}&created=${created}`,
        ),
        "workflow run list",
      );
      if (!Array.isArray(raw.workflow_runs)) {
        throw new Error("GitHub returned an invalid workflow run list");
      }
      return raw.workflow_runs;
    },
    { pageSize: 100, maxPages: MAX_RUN_PAGES, label: "depvisor run list" },
  );
  return { runs: runs.slice(0, MAX_RUNS), truncated: runs.length > MAX_RUNS };
}

async function runJobLogTail(repository: string, runId: number): Promise<string> {
  const raw = object(
    await github(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=${MAX_JOBS_PER_RUN}`),
    "workflow jobs",
  );
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  const first = jobs.find((value) => isRecord(value) && int(value.id) > 0);
  if (!isRecord(first)) return "";
  try {
    return await downloadJobLog(repository, int(first.id), JOB_LOG_TAIL_CHARS);
  } catch (error: unknown) {
    return `(job log unavailable: ${String(error)})`;
  }
}

async function summarizeRuns(repository: string): Promise<{
  runs: RunSummary[];
  truncated: boolean;
}> {
  const { runs, truncated } = await recentRuns(repository);
  const summaries: RunSummary[] = [];
  let failureBudget = MAX_TOTAL_FAILURE_CHARS;
  for (const value of runs) {
    const run = object(value, "workflow run");
    const id = int(run.id);
    if (id <= 0) continue;
    const conclusion = str(run.conclusion) || "in_progress";
    const logTail = await runJobLogTail(repository, id);
    const summary: RunSummary = {
      id,
      event: str(run.event),
      conclusion,
      headBranch: str(run.head_branch),
      htmlUrl: str(run.html_url),
      createdAt: str(run.created_at),
      attempt: int(run.run_attempt),
      durationSeconds: durationSeconds(str(run.run_started_at), str(run.updated_at)),
      outputs: parseOutputsLine(logTail),
    };
    if (conclusion !== "success" && conclusion !== "skipped" && failureBudget > 0) {
      const excerpt = logTail.slice(-Math.min(MAX_FAILURE_EXCERPT_CHARS, failureBudget));
      failureBudget -= excerpt.length;
      if (excerpt) summary.failureExcerpt = excerpt;
    }
    summaries.push(summary);
  }
  return { runs: summaries, truncated };
}

async function existingIssueTitles(
  repository: string,
): Promise<{ state: string; title: string }[]> {
  const raw = await github(
    `/repos/${repository}/issues?labels=${SELF_CHECK_LABEL}&state=all&per_page=100`,
  );
  if (!Array.isArray(raw)) throw new Error("GitHub returned an invalid issue list");
  return raw
    .filter((value) => isRecord(value) && !("pull_request" in value))
    .slice(0, MAX_EXISTING_ISSUES)
    .map((value) => {
      const issue = object(value, "issue");
      return { state: str(issue.state), title: str(issue.title).slice(0, 200) };
    });
}

async function main(): Promise<void> {
  const repository = required("DEPVISOR_REPOSITORY");
  const contextFile = required("DEPVISOR_SELFCHECK_CONTEXT_FILE");
  mkdirSync(dirname(contextFile), { recursive: true });

  const { runs, truncated } = await summarizeRuns(repository);
  const envelope = {
    version: 1,
    repository,
    windowDays: WINDOW_DAYS,
    generatedAt: new Date().toISOString(),
    runsTruncatedAt: truncated ? MAX_RUNS : null,
    runs,
    existingSelfCheckIssues: await existingIssueTitles(repository),
  };
  writeFileSync(contextFile, JSON.stringify(envelope, null, 2));

  const byConclusion = new Map<string, number>();
  for (const run of runs) {
    byConclusion.set(run.conclusion, (byConclusion.get(run.conclusion) ?? 0) + 1);
  }
  const counts = [...byConclusion.entries()].map(([key, count]) => `${key}=${count}`).join(" ");
  console.log(`self-check collected ${runs.length} depvisor run(s): ${counts || "none"}`);
  writeOutput("analyzable", runs.length > 0 ? "true" : "false");
}

main().catch((error: unknown) => {
  console.error(`::error::self-check could not collect depvisor runs: ${String(error)}`);
  process.exitCode = 1;
});
