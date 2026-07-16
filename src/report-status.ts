import { appendFileSync } from "node:fs";
import { readRunRecord, statusFails } from "./core/status.ts";
import { escapeStepSummaryText } from "./core/text.ts";
import { writeOutput } from "./shared/actions.ts";

function safeUrl(value: string | null): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !/[\r\n]/.test(value) ? value : "";
  } catch {
    return "";
  }
}

function logText(value: string): string {
  // oxlint-disable-next-line no-control-regex -- workflow-command boundary
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 2_000);
}

const file = process.env.DEPVISOR_STATUS_FILE || "";
const record = file ? readRunRecord(file) : null;
const failed = record ? statusFails(record.status) : true;
writeOutput("status", record?.status ?? "");
writeOutput("failed", failed ? "true" : "false");
writeOutput("repaired", record?.repaired ? "true" : "false");
writeOutput("pr_url", safeUrl(record?.prUrl ?? null));
writeOutput("commit_sha", /^[0-9a-f]{40}$/.test(record?.commitSha ?? "") ? record!.commitSha! : "");
writeOutput("comment_url", safeUrl(record?.commentUrl ?? null));
writeOutput("total_tokens", String(record?.usage?.totalTokens ?? 0));
writeOutput(
  "est_cost_usd",
  record?.usage && Number.isFinite(record.usage.costUsd) ? record.usage.costUsd.toFixed(6) : "",
);

const summary = record
  ? `## depvisor\n\n**${record.status}** — ${escapeStepSummaryText(record.summary)}\n\n` +
    `PR: ${safeUrl(record.prUrl) || "unavailable"}\n\n` +
    (record.changedFiles.length > 0
      ? `Repair files:\n${record.changedFiles.map((path) => `- ${escapeStepSummaryText(path, 500)}`).join("\n")}\n\n`
      : "") +
    (record.usage
      ? `Model: ${escapeStepSummaryText(record.usage.model, 500)} · tokens: ${record.usage.totalTokens} · estimated cost: $${record.usage.costUsd.toFixed(6)}\n`
      : "")
  : "## depvisor\n\n**unknown** — no readable run status was produced.\n";
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

console.log(
  `depvisor → ${record?.status ?? "unknown"}: ${logText(record?.summary ?? "no status")}`,
);
if (failed) process.exitCode = 1;
