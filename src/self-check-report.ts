/**
 * Token-holding reporter for the weekly self-check. Re-validates the analyst's
 * findings handoff, resolves every cited run against the collector envelope,
 * and files at most MAX_FINDINGS labeled issues with reporter-built links.
 * Free agent text goes only into issue titles/bodies after the shared
 * rendering boundary, never into outputs, paths, or commands.
 */

import { appendFileSync, readFileSync } from "node:fs";
import {
  MAX_FINDINGS,
  SELF_CHECK_LABEL,
  actionsRunUrl,
  parseFindingsFile,
  renderIssueBody,
  renderIssueTitle,
} from "./core/self-check.ts";
import { isRecord } from "./core/json.ts";
import { escapeStepSummaryText } from "./core/text.ts";
import { writeOutput } from "./shared/actions.ts";
import { required } from "./shared/env.ts";
import { apiBase, github, githubHeaders, object } from "./shared/github-api.ts";

function serverUrl(): string {
  return (process.env.DEPVISOR_SERVER_URL || "https://github.com").replace(/\/$/, "");
}

function summarize(text: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, text);
}

function collectedRunIds(contextFile: string): Set<number> {
  const envelope = object(JSON.parse(readFileSync(contextFile, "utf8")), "self-check envelope");
  if (!Array.isArray(envelope.runs)) throw new Error("Invalid self-check envelope: runs");
  const ids = new Set<number>();
  for (const value of envelope.runs) {
    if (!isRecord(value)) continue;
    const id = value.id;
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

async function ensureLabel(repository: string): Promise<void> {
  const response = await fetch(`${apiBase()}/repos/${repository}/labels/${SELF_CHECK_LABEL}`, {
    headers: githubHeaders(),
  });
  if (response.ok) return;
  if (response.status !== 404) {
    throw new Error(`GitHub label lookup returned ${response.status}`);
  }
  await github(`/repos/${repository}/labels`, {
    method: "POST",
    body: {
      name: SELF_CHECK_LABEL,
      color: "6f42c1",
      description: "Model-authored finding from depvisor's weekly self-check",
    },
  });
}

async function openIssueTitles(repository: string): Promise<Set<string>> {
  const raw = await github(
    `/repos/${repository}/issues?labels=${SELF_CHECK_LABEL}&state=open&per_page=100`,
  );
  if (!Array.isArray(raw)) throw new Error("GitHub returned an invalid issue list");
  const titles = new Set<string>();
  for (const value of raw) {
    if (isRecord(value) && !("pull_request" in value) && typeof value.title === "string") {
      titles.add(value.title);
    }
  }
  return titles;
}

async function main(): Promise<void> {
  const repository = required("DEPVISOR_REPOSITORY");
  const findings = parseFindingsFile(
    readFileSync(required("DEPVISOR_SELFCHECK_FINDINGS_FILE"), "utf8"),
  );
  if (findings.length === 0) {
    console.log("self-check found nothing to report this period.");
    summarize("## depvisor self-check\n\nNothing to report this period.\n");
    writeOutput("created_issues", "0");
    return;
  }

  const runIds = collectedRunIds(required("DEPVISOR_SELFCHECK_CONTEXT_FILE"));
  const server = serverUrl();
  const selfCheckRunId = Number(process.env.DEPVISOR_RUN_ID || "");
  const selfCheckRunUrl = actionsRunUrl(server, repository, selfCheckRunId);

  await ensureLabel(repository);
  const existing = await openIssueTitles(repository);

  const summaryLines: string[] = ["## depvisor self-check", ""];
  let created = 0;
  for (const finding of findings.slice(0, MAX_FINDINGS)) {
    const title = renderIssueTitle(finding);
    // Only runs the collector actually saw become evidence links, and the
    // links themselves are built here from validated components.
    const evidence = finding.evidence_run_ids
      .filter((id) => runIds.has(id))
      .flatMap((id) => {
        const url = actionsRunUrl(server, repository, id);
        return url === null ? [] : [{ runId: id, url }];
      });
    if (evidence.length === 0) {
      summaryLines.push(
        `- Dropped a finding with no resolvable evidence run: ${escapeStepSummaryText(finding.title, 200)}`,
      );
      continue;
    }
    if (existing.has(title)) {
      summaryLines.push(
        `- Skipped an already-open topic: ${escapeStepSummaryText(finding.title, 200)}`,
      );
      continue;
    }
    const issue = object(
      await github(`/repos/${repository}/issues`, {
        method: "POST",
        body: {
          title,
          body: renderIssueBody(finding, evidence, selfCheckRunUrl),
          labels: [SELF_CHECK_LABEL],
        },
      }),
      "created issue",
    );
    created += 1;
    const url = typeof issue.html_url === "string" ? issue.html_url : "";
    summaryLines.push(
      `- Created ${url || "an issue"}: ${escapeStepSummaryText(finding.title, 200)}`,
    );
    console.log(`self-check created ${url || "an issue"}`);
  }
  summarize(`${summaryLines.join("\n")}\n`);
  writeOutput("created_issues", String(created));
}

main().catch((error: unknown) => {
  console.error(`::error::self-check could not publish its findings: ${String(error)}`);
  process.exitCode = 1;
});
