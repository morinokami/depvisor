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
 * Resolve every cited run id against the collected envelope, deduplicated in
 * citation order. One unresolvable or unlinkable id rejects the whole finding:
 * a partially hallucinated evidence list must not publish the surviving half.
 */
export function resolveEvidence(
  finding: SelfCheckFinding,
  collectedRunIds: ReadonlySet<number>,
  server: string,
  repository: string,
): { runId: number; url: string }[] | null {
  const evidence: { runId: number; url: string }[] = [];
  const seen = new Set<number>();
  for (const runId of finding.evidence_run_ids) {
    if (seen.has(runId)) continue;
    seen.add(runId);
    const url = collectedRunIds.has(runId) ? actionsRunUrl(server, repository, runId) : null;
    if (url === null) return null;
    evidence.push({ runId, url });
  }
  return evidence;
}

export type PlannedFinding =
  | {
      action: "create";
      finding: SelfCheckFinding;
      title: string;
      evidence: { runId: number; url: string }[];
    }
  | { action: "skip-duplicate"; finding: SelfCheckFinding; title: string }
  | { action: "drop-unresolved"; finding: SelfCheckFinding; title: string };

/**
 * Decide per finding whether the reporter files it. Evidence must fully
 * resolve, and the rendered title must be new against both the already-open
 * issues and the titles planned earlier in the same batch: one run must never
 * file the same title twice (identical findings, truncation collisions). An
 * unresolved finding reserves no title.
 */
export function planFindings(
  findings: readonly SelfCheckFinding[],
  openTitles: ReadonlySet<string>,
  collectedRunIds: ReadonlySet<number>,
  server: string,
  repository: string,
): PlannedFinding[] {
  const taken = new Set(openTitles);
  return findings.slice(0, MAX_FINDINGS).map((finding) => {
    const title = renderIssueTitle(finding);
    const evidence = resolveEvidence(finding, collectedRunIds, server, repository);
    if (evidence === null) return { action: "drop-unresolved", finding, title };
    if (taken.has(title)) return { action: "skip-duplicate", finding, title };
    taken.add(title);
    return { action: "create", finding, title, evidence };
  });
}

// Zero-width space: invisible in rendered text, but breaks GitHub's token
// matching for autolinks, mentions, and issue references. Entity escapes
// cannot defuse those — GitHub decodes character references before matching.
const ZWSP = "\u{200B}";

/**
 * Neutralize active rendering in analyst prose on top of cleanReportText.
 * Escaping &, <, > first makes raw HTML and entity-smuggled tokens inert
 * (a literal &#64;user would otherwise still ping). The ZWSP rules then break
 * Markdown links, URL-scheme/www. autolinks, @-mention pings, and
 * #123/GH-123 cross-reference notifications while keeping the visible text
 * identical. Every live link in a self-check issue is reporter-built; nothing
 * agent-authored may render as HTML, a link, or a reference.
 */
function defusedProse(value: string, max?: number): string {
  return cleanReportText(value, max)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("](", "]\\(")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):\/\//g, `$1:${ZWSP}//`)
    .replace(/\bwww\./gi, `www${ZWSP}.`)
    .replaceAll("@", `@${ZWSP}`)
    .replace(/#(\d)/g, `#${ZWSP}$1`)
    .replace(/\bGH-(\d)/gi, `GH-${ZWSP}$1`);
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
    defusedProse(finding.detail),
    "",
    "## Evidence",
    "",
    ...evidence.map(({ runId, url }) => `- [run ${runId}](${url})`),
    "",
    "## Suggested action",
    "",
    defusedProse(finding.suggested_action, 1_000),
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
