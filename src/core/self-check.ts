/**
 * Deterministic core of the weekly self-check: the findings handoff schema,
 * the parser for the development workflow's outputs log line, and the issue
 * rendering boundary. The analyst agent only proposes findings; everything
 * that reaches GitHub is validated and rendered here.
 */

import * as v from "valibot";
import { cleanReportText } from "./text.ts";

export const SELF_CHECK_LABEL = "self-check";
export const MAX_FINDINGS = 2;

export const SelfCheckFindingsSchema = v.object({
  findings: v.pipe(
    v.array(
      v.object({
        title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
        detail: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
        evidence_run_ids: v.pipe(
          v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
          v.minLength(1),
          v.maxLength(10),
        ),
        suggested_action: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
      }),
    ),
    v.maxLength(MAX_FINDINGS),
  ),
});

export type SelfCheckFindings = v.InferOutput<typeof SelfCheckFindingsSchema>;
export type SelfCheckFinding = SelfCheckFindings["findings"][number];

const FindingsFileSchema = v.object({
  version: v.literal(1),
  findings: SelfCheckFindingsSchema.entries.findings,
});

/** Fail-closed parse of the workflow → reporter findings handoff file. */
export function parseFindingsFile(text: string): SelfCheckFinding[] {
  return v.parse(FindingsFileSchema, JSON.parse(text)).findings;
}

export interface ParsedRunOutputs {
  status: string;
  failed: boolean | null;
  repaired: boolean | null;
  totalTokens: number | null;
  estCostUsd: number | null;
}

const OUTPUTS_LINE =
  /\bstatus=(\S*) failed=(\S*) repaired=(\S*) pr=(\S*)(?: total_tokens=(\S*) est_cost_usd=(\S*))?[ \t\r]*$/gm;

function parseBool(value: string): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

/**
 * Extract the development workflow's `status=… failed=…` echo from a job-log
 * tail. The last lexically valid match wins: earlier matches can be the
 * unexpanded `echo "status=$STATUS …"` command header the runner prints. Runs
 * older than the cost echo carry no total_tokens/est_cost_usd fields.
 */
export function parseOutputsLine(log: string): ParsedRunOutputs | null {
  let parsed: ParsedRunOutputs | null = null;
  for (const match of log.matchAll(OUTPUTS_LINE)) {
    const [, status = "", failed = "", repaired = "", , tokens, cost] = match;
    if (!/^[a-z][a-z-]{0,39}$/.test(status)) continue;
    const totalTokens = tokens !== undefined && /^\d{1,12}$/.test(tokens) ? Number(tokens) : null;
    const estCostUsd =
      cost !== undefined && /^\d{1,7}(\.\d{1,9})?$/.test(cost) ? Number(cost) : null;
    parsed = {
      status,
      failed: parseBool(failed),
      repaired: parseBool(repaired),
      totalTokens,
      estCostUsd,
    };
  }
  return parsed;
}

/** Build one https://…/actions/runs/<id> URL from validated components only. */
export function actionsRunUrl(server: string, repository: string, runId: number): string | null {
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(server)) return null;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) return null;
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  return `${server}/${repository}/actions/runs/${runId}`;
}

/**
 * Render one finding as an issue body. The title/detail/action prose is
 * agent-authored and untrusted; every link is builder-supplied and already
 * validated by the reporter, never taken from agent text.
 */
export function renderIssueBody(
  finding: SelfCheckFinding,
  evidence: { runId: number; url: string }[],
  selfCheckRunUrl: string | null,
): string {
  const lines = [
    "depvisor's weekly self-check flagged this while reading its own recent workflow runs.",
    "The analysis below is model-authored from bounded run logs; verify before acting.",
    "",
    "## Observation",
    "",
    cleanReportText(finding.detail),
    "",
    "## Evidence",
    "",
    ...evidence.map(({ runId, url }) => `- [run ${runId}](${url})`),
    "",
    "## Suggested action",
    "",
    cleanReportText(finding.suggested_action, 1_000),
  ];
  if (selfCheckRunUrl) {
    lines.push("", `---`, "", `Reported by [this self-check run](${selfCheckRunUrl}).`);
  }
  return lines.join("\n");
}

/** Issue title rendered from an untrusted finding title. */
export function renderIssueTitle(finding: SelfCheckFinding): string {
  return `self-check: ${cleanReportText(finding.title, 120)}`;
}
