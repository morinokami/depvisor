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
 * Token/cost usage for ONE agent operation within a group, projected from Flue's
 * `PromptResultResponse.usage`/`.model` at the workflow boundary (kept
 * structural, so core stays Flue-free). Numbers only — no untrusted text, so it
 * never touches token separation or the gates. `costUsd` is Flue's
 * provider-priced estimate (BYOK-approximate), not an invoice. `role` names
 * which operation spent it: the agent-as-fixer flow can run up to two per group
 * (the failure-path `fixer` and the PR `digest`), recorded as separate entries —
 * see GroupResult.usage.
 */
export interface GroupUsage {
  role: "fixer" | "digest";
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
   * Test-looking files this update changed (visibility, not a gate — see
   * core/test-changes.ts; the fixer or a lifecycle script can both be the
   * writer). Optional/absent when none changed; record-only, so it is
   * deliberately NOT in RUN_OUTPUT_SCHEMA below.
   */
  testChanges?: NumstatEntry[];
  /**
   * Token/cost usage for this group's agent operations (visibility only), one
   * entry per operation that actually ran: 0 for outcomes that ran no agent
   * (skip/held-back/branch-collision/release-age-unavailable/bump-failed, or a
   * prompt that threw before returning), 1 when only one of fixer/digest ran, 2
   * when both did. Absent/empty when zero ran. Record-only, like `testChanges` —
   * NOT in RUN_OUTPUT_SCHEMA.
   */
  usage?: GroupUsage[];
  prUrl: string | null;
}

/**
 * A run's aggregate status: run-level fields plus one entry per group the run
 * touched. A run can prepare several PRs (up to `open_pull_requests_limit` open depvisor PRs), so
 * the group array carries the per-PR detail while `status` describes the run as
 * a whole (`completed`/`dry-run-completed`, or a run-level stop like
 * `no-updates`/`baseline-red`).
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

// Charset gates for the `$GITHUB_OUTPUT` boundary. Outputs feed `${{ }}`
// interpolation in consumer workflows — a classic command/shell-injection
// surface — so only fixed-vocabulary statuses (every depvisor status is
// kebab-case, `readRunStatus`'s "unknown" fallback included) and
// strictly-shaped PR URLs pass; free text (summaries) is never emitted. The
// URL charset has no `:` beyond the scheme, so a GHES `server_url` with a
// custom port fails the gate — the URL is dropped (fail-closed), nothing else.
const OUTPUT_STATUS_RE = /^[a-z-]+$/;
const OUTPUT_PR_URL_RE = /^https:\/\/[A-Za-z0-9./_-]+$/;

/** The action's `outputs:` values, keyed exactly as action.yml declares them. */
export type ActionOutputs = {
  status: string;
  failed: string;
  prepared_count: string;
  pr_urls: string;
  total_tokens: string;
  est_cost_usd: string;
};

const ZERO_USAGE_OUTPUTS = { total_tokens: "0", est_cost_usd: "0.000000" } as const;
const UNAVAILABLE_USAGE_OUTPUTS = { total_tokens: "0", est_cost_usd: "" } as const;

/**
 * Project the already-recorded per-operation usage into numeric-only action
 * outputs. The status file is untrusted at read-back, so validate every value
 * again at this exit boundary: tokens must be non-negative safe integers and
 * costs non-negative finite numbers. Invalid tokens fail toward zero; an
 * invalid cost leaves only the estimate empty, preserving an independently
 * valid token total. Neither can become a free-form value in `${{ }}`
 * interpolation.
 *
 * Flue represents an unpriced model with zero cost rather than a separate
 * "price unavailable" bit. A token-bearing zero-cost operation therefore makes
 * the WHOLE run estimate unavailable — emitting the sum of only priced
 * operations would understate the total. This also conservatively treats a
 * genuinely free model as unavailable; the current Flue response cannot
 * distinguish those cases. A valid run with no agent operation has a known
 * zero cost instead.
 */
function usageActionOutputs(
  groups: GroupResult[],
): Pick<ActionOutputs, "total_tokens" | "est_cost_usd"> {
  const entries = groups.flatMap((g) => g.usage ?? []);
  if (entries.length === 0) return ZERO_USAGE_OUTPUTS;
  if (entries.some((u) => !Number.isSafeInteger(u.totalTokens) || u.totalTokens < 0)) {
    return UNAVAILABLE_USAGE_OUTPUTS;
  }
  const usage = sumGroupUsage(groups);
  if (!usage || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0) {
    return UNAVAILABLE_USAGE_OUTPUTS;
  }
  const costUnavailable =
    !Number.isFinite(usage.costUsd) ||
    usage.costUsd < 0 ||
    entries.some(
      (u) =>
        !Number.isFinite(u.costUsd) ||
        u.costUsd < 0 ||
        (u.totalTokens === 0 && u.costUsd !== 0) ||
        (u.totalTokens > 0 && u.costUsd === 0),
    );
  return {
    total_tokens: String(usage.totalTokens),
    est_cost_usd: costUnavailable ? "" : usage.costUsd.toFixed(6),
  };
}

/**
 * The action-outputs projection of a run: the bridge that lets consumer
 * workflow steps branch on the result (notify on new PRs, skip follow-up
 * jobs, …). `null` means the status file was never written — a setup or agent
 * step crashed before reporting — and still yields `failed: "true"` so
 * `if: always()` consumers get a signal exactly when they need it most.
 * `prepared_count` counts `pr-prepared` groups as patched by the open-pr step,
 * i.e. groups whose PR was opened or refreshed (a blocked/failed open-pr has
 * already left that status); `pr_urls` is those PRs' URLs, newline-separated.
 * `total_tokens`/`est_cost_usd` reuse the same per-operation records as the step
 * summary; no second accounting path or provider call is introduced.
 */
export function toActionOutputs(run: RunStatus | null): ActionOutputs {
  if (!run) {
    return {
      status: "",
      failed: "true",
      prepared_count: "0",
      pr_urls: "",
      ...UNAVAILABLE_USAGE_OUTPUTS,
    };
  }
  const urls = run.groups
    .map((g) => g.prUrl)
    .filter((url): url is string => url !== null && OUTPUT_PR_URL_RE.test(url));
  return {
    // An off-vocabulary status is dropped, not escaped; `failed` derives from
    // the raw status (off-vocabulary is not in OK_STATUSES, so it fails), so
    // the gate can never launder a failure into a green-looking output.
    status: OUTPUT_STATUS_RE.test(run.status) ? run.status : "",
    failed: runFailsJob(run) ? "true" : "false",
    prepared_count: String(run.groups.filter((g) => g.status === "pr-prepared").length),
    pr_urls: urls.join("\n"),
    ...usageActionOutputs(run.groups),
  };
}

// Benign outcomes that stay green. Covers both run-level (`completed`,
// `dry-run-completed`, `no-updates`) and group-level statuses. `open-pr-blocked` is green because a
// human having taken over the PR branch is expected (see open-pr.ts);
// `held-back-by-limit` is green because the open_pull_requests_limit ceiling doing its job is
// normal operation, not a failure. Everything else — including the
// `in-progress` marker the workflow writes incrementally (which only a graceful
// finish upgrades to `completed`) and the per-group `bump-failed` (the
// deterministic bump or its install failed for a group — agent-as-fixer;
// red, per-group, the run continues) — fails the job.
const OK_STATUSES = new Set([
  "completed",
  "dry-run-completed",
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
 * Sum usage across every group AND every agent operation within it (a group can
 * now carry a fixer entry and a digest entry). Groups without `usage` — skips,
 * hold-backs, bump-failed, no-structured-result — contribute nothing. Returns
 * null when no operation ran anywhere, so callers render nothing rather than a
 * misleading zero-token row. `groupCount` counts GROUPS that ran ≥1 operation,
 * not operations, so a two-operation group still counts once.
 */
export function sumGroupUsage(groups: GroupResult[]): RunUsage | null {
  const groupsWithUsage = groups.filter((g) => (g.usage?.length ?? 0) > 0);
  const all = groupsWithUsage.flatMap((g) => g.usage ?? []);
  if (all.length === 0) return null;
  const models = new Set(all.map((u) => u.model).filter((m): m is string => Boolean(m)));
  return { ...sumUsageEntries(all), models: [...models], groupCount: groupsWithUsage.length };
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
    status: raw.status ?? "unknown",
    branch: typeof raw.branch === "string" ? raw.branch : null,
    group: typeof raw.group === "string" ? raw.group : null,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    packages: Array.isArray(raw.packages) ? raw.packages : [],
    verification: Array.isArray(raw.verification) ? raw.verification : [],
    prUrl: typeof raw.prUrl === "string" ? raw.prUrl : null,
  };
  // Preserve testChanges across the open-pr read→rewrite round-trip; parseGroup
  // rebuilds the object field-by-field, so an omitted field would be silently
  // dropped when open-pr patches the PR URL back in.
  if (Array.isArray(raw.testChanges) && raw.testChanges.length > 0) {
    group.testChanges = raw.testChanges;
  }
  // Same round-trip concern for usage — a list of numeric-only records,
  // re-normalized defensively (a hand-edited/truncated status file must not
  // crash the report), so it survives the open-pr read→rewrite intact.
  const usage = parseUsageList(raw.usage);
  if (usage.length > 0) group.usage = usage;
  return group;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsageList(raw: unknown): GroupUsage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const u = parseUsage(entry);
    return u ? [u] : [];
  });
}

function parseUsage(raw: unknown): GroupUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Partial<GroupUsage>;
  // A usage entry with no recognized role is illegible; drop it (display-only,
  // so failing toward "render nothing" is the safe direction).
  if (u.role !== "fixer" && u.role !== "digest") return null;
  return {
    role: u.role,
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
  // The status file is untrusted at read-back (the tokenless step wrote it,
  // like the payloads), and the reporter exists to surface failures — so a
  // truncated/corrupt write or a non-object root must read as null (= no
  // status), the direction every caller already fails toward, not crash the
  // report before it can write its outputs (or crash open-pr mid-loop and
  // break its per-payload isolation).
  let parsed: Partial<RunStatus>;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    parsed = raw;
  } catch {
    return null;
  }
  return {
    status: parsed.status ?? "unknown",
    base: typeof parsed.base === "string" ? parsed.base : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    groups: Array.isArray(parsed.groups)
      ? (parsed.groups as Partial<GroupResult>[]).map(parseGroup)
      : [],
  };
}

/**
 * Record one payload's outcome from the token-holding open-pr step: patch the
 * group entry whose branch matches (the PR URL, or an open-pr-blocked/
 * open-pr-failed status) without disturbing other groups — or, when no entry
 * matches (an unreadable payload with no known branch, or a payload naming a
 * branch the run never recorded), APPEND a synthetic entry instead. The
 * append matters: this file is what the report step projects the job result
 * from, and a payload failure that leaves the stale `pr-prepared` entry
 * standing would report `failed="false"` while the open-pr step's non-zero
 * exit turns the job red. `fallback` supplies the appended entry's
 * status/summary when `patch` carries neither (the opened-PR path patches only
 * `prUrl`); without it the append fails toward `open-pr-failed`. Returns null
 * when the status file is missing/unreadable — report-status's null path
 * already reports that as a failure.
 */
export function recordGroupOutcome(
  file: string,
  branch: string | null,
  patch: Partial<GroupResult>,
  fallback?: Pick<GroupResult, "status" | "summary">,
): RunStatus | null {
  const current = readRunStatus(file);
  if (!current) return null;
  let matched = false;
  const groups = current.groups.map((g) => {
    if (branch === null || g.branch !== branch) return g;
    matched = true;
    return { ...g, ...patch };
  });
  if (!matched) {
    groups.push({
      status: "open-pr-failed",
      branch,
      group: null,
      summary: "",
      packages: [],
      verification: [],
      prUrl: null,
      ...fallback,
      ...patch,
    });
  }
  const next: RunStatus = { ...current, groups };
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

function mdCell(value: string | number | null | undefined): string {
  return sanitizeSummary(String(value ?? ""))
    .replace(/\s*\r?\n\s*/g, " ")
    .replaceAll("|", "\\|");
}

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Provider-priced estimate, so signal it: `~$0.1234` (BYOK-approximate). */
function fmtCost(n: number): string {
  return `~$${n.toFixed(4)}`;
}

/** Sum a group's per-operation usage entries into the digest's numeric shape. */
function sumUsageEntries(list: readonly GroupUsage[]): {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
} {
  const total = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const u of list) {
    total.totalTokens += u.totalTokens;
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.costUsd += u.costUsd;
  }
  return total;
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
 * A step-summary block flagging test files this update changed, so a maintainer
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
    `#### ⚠️ Tests modified in this update (${changes.length})`,
    "",
    ...(rows.length > 0 ? ["| File | Lines |", "|---|---|", ...rows, ""] : []),
    ...(omitted > 0 ? [`_${omitted} file(s) with unsafe names omitted._`, ""] : []),
  ].join("\n");
}

function renderGroup(group: GroupResult): string {
  const heading = `### Group \`${mdCell(group.group ?? "?")}\` — \`${mdCell(group.status)}\``;
  const rows = [`| Branch | ${group.branch ? `\`${mdCell(group.branch)}\`` : "none"} |`];
  if (group.prUrl) rows.push(`| PR | ${mdCell(group.prUrl)} |`);
  if (group.usage && group.usage.length > 0) {
    // Group total, then a compact per-role breakdown (`fixer 12,345 + digest
    // 2,111`) so a two-operation group shows where the tokens went. Distinct
    // models are joined (usually one).
    const summed = sumUsageEntries(group.usage);
    const breakdown = group.usage.map((u) => `${u.role} ${fmtTokens(u.totalTokens)}`).join(" + ");
    const models = [...new Set(group.usage.map((u) => u.model).filter((m) => m.length > 0))];
    rows.push(
      `| LLM usage | ${usageDigest(summed)} · ${breakdown} — \`${mdCell(models.join(", "))}\` |`,
    );
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
