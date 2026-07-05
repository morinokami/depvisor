import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { sanitizeSummary } from "./pr.ts";
import { RUN_STATUS_FILE } from "./status-file.ts";
import type { Candidate } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

export { RUN_STATUS_FILE };

export interface StatusPackage {
  name: string;
  current: string;
  latest: string;
  kind: Candidate["kind"];
  updateType: Candidate["updateType"];
}

/** One group's outcome within a run — the unit the PR/annotation UX renders. */
export interface GroupResult {
  status: string;
  branch: string | null;
  group: string | null;
  summary: string;
  packages: StatusPackage[];
  verification: VerifyResult[];
  prUrl: string | null;
}

/**
 * A run's aggregate status: run-level fields plus one entry per group the run
 * touched. A run can prepare several PRs (up to `max_prs` open depvisor PRs), so
 * the group array carries the per-PR detail while `status` describes the run as
 * a whole (`completed`, or a run-level stop like `no-updates`/`baseline-red`).
 */
export interface RunStatus {
  status: string;
  base: string | null;
  summary: string;
  groups: GroupResult[];
}

/**
 * The workflow-facing view of a run: `RunStatus` minus per-group `packages` and
 * `prUrl` (the full record lives in status.json). Schema and projector are one
 * definition — `toRunOutput` is a `v.parse`, and `v.object` strips the extra
 * keys — so the workflow output cannot silently drift from `RunStatus`.
 */
export const RUN_OUTPUT_SCHEMA = v.object({
  status: v.string(),
  base: v.nullable(v.string()),
  summary: v.string(),
  groups: v.array(
    v.object({
      status: v.string(),
      branch: v.nullable(v.string()),
      group: v.nullable(v.string()),
      summary: v.string(),
      verification: v.array(
        v.object({ name: v.string(), ok: v.boolean(), code: v.nullable(v.number()) }),
      ),
    }),
  ),
});

export function toRunOutput(run: RunStatus): v.InferOutput<typeof RUN_OUTPUT_SCHEMA> {
  return v.parse(RUN_OUTPUT_SCHEMA, run);
}

// Benign outcomes that stay green. Covers both run-level (`completed`,
// `no-updates`) and group-level statuses. `open-pr-blocked` is green because a
// human having taken over the PR branch is expected (see open-pr.ts);
// `held-back-by-limit` is green because the max_prs ceiling doing its job is
// normal operation, not a failure. Everything else — including the
// `in-progress` marker the workflow writes incrementally, which only a
// graceful finish upgrades to `completed` — fails the job.
const OK_STATUSES = new Set([
  "completed",
  "no-updates",
  "pr-prepared",
  "pr-up-to-date",
  "deferred",
  "open-pr-blocked",
  "held-back-by-limit",
]);

export function statusPackages(candidates: Candidate[]): StatusPackage[] {
  return candidates.map(({ name, current, latest, kind, updateType }) => ({
    name,
    current,
    latest,
    kind,
    updateType,
  }));
}

export function statusPath(outDir: string): string {
  return join(outDir, RUN_STATUS_FILE);
}

export function emitRunStatus(outDir: string, status: RunStatus): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = statusPath(outDir);
  writeFileSync(outPath, JSON.stringify(status, null, 2));
  return outPath;
}

function parseGroup(raw: Partial<GroupResult>): GroupResult {
  return {
    status: String(raw.status ?? "unknown"),
    branch: typeof raw.branch === "string" ? raw.branch : null,
    group: typeof raw.group === "string" ? raw.group : null,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    packages: Array.isArray(raw.packages) ? (raw.packages as StatusPackage[]) : [],
    verification: Array.isArray(raw.verification) ? (raw.verification as VerifyResult[]) : [],
    prUrl: typeof raw.prUrl === "string" ? raw.prUrl : null,
  };
}

export function readRunStatus(file: string): RunStatus | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RunStatus>;
  return {
    status: String(parsed.status ?? "unknown"),
    base: typeof parsed.base === "string" ? parsed.base : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    groups: Array.isArray(parsed.groups)
      ? (parsed.groups as Partial<GroupResult>[]).map(parseGroup)
      : [],
  };
}

/**
 * Patch the group entry whose branch matches `branch` and rewrite the file. Used
 * by the token-holding open-pr step to write back per-PR results (the PR URL, or
 * an open-pr-blocked/open-pr-failed status) without disturbing other groups.
 */
export function updateGroupStatus(
  file: string,
  branch: string,
  patch: Partial<GroupResult>,
): RunStatus | null {
  const current = readRunStatus(file);
  if (!current) return null;
  const next: RunStatus = {
    ...current,
    groups: current.groups.map((g) => (g.branch === branch ? { ...g, ...patch } : g)),
  };
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

/** Whether a single status string is a job-failing outcome. */
export function statusFailsJob(status: string): boolean {
  return !OK_STATUSES.has(status);
}

/**
 * Whether the run should fail the job: a run-level failure, OR any group with a
 * job-failing status. A `completed` run still fails the job when a group ended
 * in e.g. `verification-failed`, so silent no-PR outcomes still notify users.
 */
export function runFailsJob(status: RunStatus): boolean {
  return statusFailsJob(status.status) || status.groups.some((g) => statusFailsJob(g.status));
}

function oneLine(value: string): string {
  return sanitizeSummary(value)
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/^\s*::/, ": :")
    .trim();
}

/** Run-level one-line summary for logs and the top annotation. */
export function runLogLine(status: RunStatus): string {
  const parts = [`status=${status.status}`];
  if (status.base) parts.push(`base=${status.base}`);
  if (status.groups.length > 0) {
    const counts = new Map<string, number>();
    for (const g of status.groups) counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
    const breakdown = [...counts.entries()].map(([s, n]) => `${s}=${n}`).join(", ");
    parts.push(`groups=${status.groups.length} (${breakdown})`);
  }
  const summary = oneLine(status.summary);
  return summary ? `${parts.join(" ")} - ${summary}` : parts.join(" ");
}

/** Per-group one-line summary for logs and per-group annotations. */
export function groupLogLine(group: GroupResult): string {
  const parts = [`status=${group.status}`];
  if (group.group) parts.push(`group=${group.group}`);
  if (group.branch) parts.push(`branch=${group.branch}`);
  if (group.prUrl) parts.push(`pr=${group.prUrl}`);
  const summary = oneLine(group.summary);
  return summary ? `${parts.join(" ")} - ${summary}` : parts.join(" ");
}

function mdCell(value: unknown): string {
  return sanitizeSummary(String(value ?? ""))
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|");
}

function packageTable(packages: StatusPackage[]): string {
  if (packages.length === 0) return "";
  const rows = packages.map(
    (p) =>
      `| ${mdCell(p.name)} | ${mdCell(p.current)} | ${mdCell(p.latest)} | ${mdCell(p.kind)} | ${mdCell(p.updateType)} |`,
  );
  return [
    "#### Packages",
    "",
    "| Package | From | To | Kind | Type |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function verificationTable(results: VerifyResult[]): string {
  if (results.length === 0) return "";
  const rows = results.map(
    (r) => `| ${r.ok ? "pass" : "fail"} | ${mdCell(r.name)} | ${mdCell(r.code)} |`,
  );
  return [
    "#### Verification",
    "",
    "| Result | Command | Exit |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function renderGroup(group: GroupResult): string {
  const heading = `### Group \`${mdCell(group.group ?? "?")}\` — \`${mdCell(group.status)}\``;
  const rows = [`| Branch | ${group.branch ? `\`${mdCell(group.branch)}\`` : "none"} |`];
  if (group.prUrl) rows.push(`| PR | ${mdCell(group.prUrl)} |`);
  return [
    heading,
    "",
    "| Field | Value |",
    "|---|---|",
    ...rows,
    "",
    mdCell(group.summary) || "No summary was emitted.",
    "",
    packageTable(group.packages),
    verificationTable(group.verification),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function renderStepSummary(status: RunStatus): string {
  const header = [
    "## depvisor",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Status | \`${mdCell(status.status)}\` |`,
    `| Base | ${status.base ? `\`${mdCell(status.base)}\`` : "none"} |`,
    `| Groups | ${status.groups.length} |`,
    "",
    "### Summary",
    "",
    mdCell(status.summary) || "No summary was emitted.",
    "",
  ].join("\n");
  return [header, ...status.groups.map(renderGroup)].filter((part) => part !== "").join("\n");
}

export function appendStepSummary(file: string, status: RunStatus): void {
  appendFileSync(file, `${renderStepSummary(status)}\n`);
}
