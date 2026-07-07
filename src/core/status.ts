import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { NumstatEntry } from "./git.ts";
import { isDisplayablePath, sanitizeSummary } from "./pr.ts";
import { RUN_STATUS_FILE } from "./status-file.ts";
import { formatNumstatLines } from "./test-changes.ts";
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

/**
 * Token/cost usage for the agent session that processed one group, projected
 * from Flue's `PromptResultResponse.usage`/`.model` at the workflow boundary
 * (kept structural, so core stays Flue-free). Numbers only — no untrusted text,
 * so it never touches token separation or the gates. `costUsd` is Flue's
 * provider-priced estimate (BYOK-approximate), not an invoice.
 */
export interface GroupUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  /** `provider/id` of the model that did the work (from `response.model`). */
  model: string;
}

/** Run-level usage: the sum of every group whose agent actually ran. */
export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  /** Distinct models seen across the summed groups (usually one). */
  models: string[];
  /** How many groups contributed usage (i.e. actually ran the agent). */
  groupCount: number;
}

/** One group's outcome within a run — the unit the PR/annotation UX renders. */
export interface GroupResult {
  status: string;
  branch: string | null;
  group: string | null;
  summary: string;
  packages: StatusPackage[];
  verification: VerifyResult[];
  /**
   * Test-looking files the agent changed while adapting this update (visibility,
   * not a gate — see core/test-changes.ts). Optional/absent when none changed;
   * record-only, so it is deliberately NOT in RUN_OUTPUT_SCHEMA below.
   */
  testChanges?: NumstatEntry[];
  /**
   * Token/cost usage for this group's agent session (visibility only). Absent
   * for outcomes that never ran the agent (skip/held-back/branch-collision/
   * release-age-unavailable) and for the `no-structured-result` case where the
   * prompt threw before returning a response (`ResultUnavailableError`); the
   * other `no-structured-result` case — a returned response whose defensive
   * re-parse rejected — does carry usage (tokens were spent). Record-only, like
   * `testChanges` — NOT in RUN_OUTPUT_SCHEMA.
   */
  usage?: GroupUsage;
  prUrl: string | null;
}

/**
 * A run's aggregate status: run-level fields plus one entry per group the run
 * touched. A run can prepare several PRs (up to `max_open_prs` open depvisor PRs), so
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
// `held-back-by-limit` is green because the max_open_prs ceiling doing its job is
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

/**
 * Sum the per-group usage of every group whose agent ran (groups without
 * `usage` — skips, hold-backs, no-structured-result — contribute nothing).
 * Returns null when no group ran the agent, so callers render nothing rather
 * than a misleading zero-token row.
 */
export function sumGroupUsage(groups: GroupResult[]): RunUsage | null {
  const withUsage = groups.flatMap((g) => (g.usage ? [g.usage] : []));
  if (withUsage.length === 0) return null;
  const models = new Set<string>();
  const total: RunUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    models: [],
    groupCount: withUsage.length,
  };
  for (const u of withUsage) {
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.totalTokens += u.totalTokens;
    total.costUsd += u.costUsd;
    if (u.model) models.add(u.model);
  }
  total.models = [...models];
  return total;
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
  const group: GroupResult = {
    status: String(raw.status ?? "unknown"),
    branch: typeof raw.branch === "string" ? raw.branch : null,
    group: typeof raw.group === "string" ? raw.group : null,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    packages: Array.isArray(raw.packages) ? (raw.packages as StatusPackage[]) : [],
    verification: Array.isArray(raw.verification) ? (raw.verification as VerifyResult[]) : [],
    prUrl: typeof raw.prUrl === "string" ? raw.prUrl : null,
  };
  // Preserve testChanges across the open-pr read→rewrite round-trip; parseGroup
  // rebuilds the object field-by-field, so an omitted field would be silently
  // dropped when open-pr patches the PR URL back in.
  if (Array.isArray(raw.testChanges) && raw.testChanges.length > 0) {
    group.testChanges = raw.testChanges as NumstatEntry[];
  }
  // Same round-trip concern for usage — a numeric-only record, re-normalized
  // defensively (a hand-edited/truncated status file must not crash the report).
  const usage = parseUsage(raw.usage);
  if (usage) group.usage = usage;
  return group;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsage(raw: unknown): GroupUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Partial<GroupUsage>;
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    totalTokens: num(u.totalTokens),
    costUsd: num(u.costUsd),
    model: typeof u.model === "string" ? u.model : "",
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
  const usage = sumGroupUsage(status.groups);
  if (usage) parts.push(`tokens=${usage.totalTokens} cost=${fmtCost(usage.costUsd)}`);
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

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Provider-priced estimate, so signal it: `~$0.1234` (BYOK-approximate). */
function fmtCost(n: number): string {
  return `~$${n.toFixed(4)}`;
}

/**
 * One-line token/cost digest shared by the run header and per-group tables. The
 * numbers are Flue-provided (no user input); the model id is charset-escaped via
 * mdCell at the call site.
 */
function usageDigest(u: {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}): string {
  // The four token buckets are additive (totalTokens = in + out + cacheRead +
  // cacheWrite), and cache writes are billed, so name both cache buckets when
  // present — otherwise the breakdown wouldn't sum to the total shown.
  const cacheRead = u.cacheRead > 0 ? ` · cache read ${fmtTokens(u.cacheRead)}` : "";
  const cacheWrite = u.cacheWrite > 0 ? ` · cache write ${fmtTokens(u.cacheWrite)}` : "";
  return `${fmtTokens(u.totalTokens)} tokens (in ${fmtTokens(u.input)} · out ${fmtTokens(u.output)}${cacheRead}${cacheWrite}), est. ${fmtCost(u.costUsd)}`;
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

/**
 * A step-summary block flagging test files the agent changed, so a maintainer
 * sees it in the Actions UI before the PR is even opened. Paths are charset-
 * validated (`isDisplayablePath`) before embedding, exactly like the PR body;
 * any dropped for unsafe names are still counted.
 */
function testChangesTable(changes: NumstatEntry[]): string {
  if (changes.length === 0) return "";
  const safe = changes.filter((c) => isDisplayablePath(c.path));
  const omitted = changes.length - safe.length;
  const rows = safe.map((c) => `| \`${c.path}\` | ${formatNumstatLines(c)} |`);
  return [
    `#### ⚠️ Tests modified by the agent (${changes.length})`,
    "",
    ...(rows.length > 0 ? ["| File | Lines |", "|---|---|", ...rows, ""] : []),
    ...(omitted > 0 ? [`_${omitted} file(s) with unsafe names omitted._`, ""] : []),
  ].join("\n");
}

function renderGroup(group: GroupResult): string {
  const heading = `### Group \`${mdCell(group.group ?? "?")}\` — \`${mdCell(group.status)}\``;
  const rows = [`| Branch | ${group.branch ? `\`${mdCell(group.branch)}\`` : "none"} |`];
  if (group.prUrl) rows.push(`| PR | ${mdCell(group.prUrl)} |`);
  if (group.usage) {
    rows.push(`| LLM usage | ${usageDigest(group.usage)} — \`${mdCell(group.usage.model)}\` |`);
  }
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
    testChangesTable(group.testChanges ?? []),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function renderStepSummary(status: RunStatus): string {
  const usage = sumGroupUsage(status.groups);
  const header = [
    "## depvisor",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Status | \`${mdCell(status.status)}\` |`,
    `| Base | ${status.base ? `\`${mdCell(status.base)}\`` : "none"} |`,
    `| Groups | ${status.groups.length} |`,
    ...(usage
      ? [`| LLM usage | ${usageDigest(usage)} — \`${mdCell(usage.models.join(", "))}\` |`]
      : []),
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
