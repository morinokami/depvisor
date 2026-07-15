import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { NumstatEntry } from "./git.ts";
import { isDisplayablePath, sanitizeSummary } from "./report.ts";
import { RUN_STATUS_FILE } from "./status-file.ts";
import { formatNumstatLines } from "./test-changes.ts";
import type { DependencyChange } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

export { RUN_STATUS_FILE };

/**
 * One aftercare run serves exactly one updater PR, so the status is flat: no
 * group array, one terminal status string. The workflow writes it
 * incrementally (starting at the red `in-progress` crash marker that only a
 * graceful finish upgrades), the token-holding publish step patches the
 * publish outcome in, and report-status.ts projects it into annotations, the
 * step summary, and the action outputs.
 */

/**
 * Token/cost usage for ONE agent operation, projected from Flue's
 * `PromptResultResponse.usage`/`.model` at the workflow boundary (kept
 * structural, so core stays Flue-free). Numbers only — no untrusted text, so it
 * never touches token separation or the gates. `costUsd` is Flue's
 * provider-priced estimate (BYOK-approximate), not an invoice. `role` names
 * which operation spent it: a run can hold up to two entries (the failure-path
 * `fixer` and the report `digest`).
 */
export interface OpUsage {
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

/** A run's aggregate status — the unit report-status renders. */
export interface RunStatus {
  status: string;
  baseRef: string | null;
  headRef: string | null;
  /** The updater tip this run consumed (null before preflight resolved it). */
  headSha: string | null;
  prNumber: number | null;
  summary: string;
  /** The dependency changes the PR carries (empty before/without analysis). */
  changes: DependencyChange[];
  verification: VerifyResult[];
  /** Whether trusted workflow code created a validated repair commit. */
  repaired: boolean;
  /**
   * Test-looking files the repair changed (visibility, not a gate — see
   * core/test-changes.ts). Optional/absent when none changed; record-only, so
   * it is deliberately NOT in RUN_OUTPUT_SCHEMA below.
   */
  testChanges?: NumstatEntry[];
  /**
   * Token/cost usage for this run's agent operations (visibility only), one
   * entry per operation that actually ran. Absent/empty when zero ran.
   * Record-only, like `testChanges` — NOT in RUN_OUTPUT_SCHEMA.
   */
  usage?: OpUsage[];
  /** URL of the published report comment, patched in by the publish step. */
  commentUrl: string | null;
}

/** A fresh status shell; callers override what they know. */
export function emptyRunStatus(status: string, summary: string): RunStatus {
  return {
    status,
    baseRef: null,
    headRef: null,
    headSha: null,
    prNumber: null,
    summary,
    changes: [],
    verification: [],
    repaired: false,
    commentUrl: null,
  };
}

/**
 * The workflow-facing view of a run: `RunStatus` minus the record-only fields.
 * Schema and projector are one definition — `toRunOutput` is a `v.parse`, and
 * `v.object` strips the extra keys — so the workflow output cannot silently
 * drift from `RunStatus`.
 */
export const RUN_OUTPUT_SCHEMA = v.object({
  status: v.string(),
  baseRef: v.nullable(v.string()),
  headRef: v.nullable(v.string()),
  headSha: v.nullable(v.string()),
  prNumber: v.nullable(v.number()),
  summary: v.string(),
  repaired: v.boolean(),
  verification: v.array(
    v.object({ name: v.string(), ok: v.boolean(), code: v.nullable(v.number()) }),
  ),
});

export function toRunOutput(run: RunStatus): v.InferOutput<typeof RUN_OUTPUT_SCHEMA> {
  return v.parse(RUN_OUTPUT_SCHEMA, run);
}

// Charset gates for the `$GITHUB_OUTPUT` boundary. Outputs feed `${{ }}`
// interpolation in consumer workflows — a classic command/shell-injection
// surface — so only fixed-vocabulary statuses (every depvisor status is
// kebab-case, `readRunStatus`'s "unknown" fallback included) and
// strictly-shaped comment URLs pass; free text (summaries) is never emitted.
// The URL charset allows `#` for GitHub's `#issuecomment-<id>` anchors and has
// no `:` beyond the scheme, so a GHES `server_url` with a custom port fails
// the gate — the URL is dropped (fail-closed), nothing else.
const OUTPUT_STATUS_RE = /^[a-z-]+$/;
const OUTPUT_URL_RE = /^https:\/\/[A-Za-z0-9./_#-]+$/;

/** The action's `outputs:` values, keyed exactly as action.yml declares them. */
export type ActionOutputs = {
  status: string;
  failed: string;
  repaired: string;
  comment_url: string;
  total_tokens: string;
  est_cost_usd: string;
};

const ZERO_USAGE_OUTPUTS = { total_tokens: "0", est_cost_usd: "0.000000" } as const;
const UNAVAILABLE_USAGE_OUTPUTS = { total_tokens: "0", est_cost_usd: "" } as const;

/** Run-level usage: the sum of the operations that actually ran, or null. */
export function sumUsage(entries: readonly OpUsage[] | undefined): {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  models: string[];
} | null {
  if (!entries || entries.length === 0) return null;
  const total = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const u of entries) {
    total.totalTokens += u.totalTokens;
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.costUsd += u.costUsd;
  }
  const models = [...new Set(entries.map((u) => u.model).filter((m) => m.length > 0))];
  return { ...total, models };
}

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
 * operations would understate the total.
 */
function usageActionOutputs(
  entries: readonly OpUsage[] | undefined,
): Pick<ActionOutputs, "total_tokens" | "est_cost_usd"> {
  if (!entries || entries.length === 0) return ZERO_USAGE_OUTPUTS;
  if (entries.some((u) => !Number.isSafeInteger(u.totalTokens) || u.totalTokens < 0)) {
    return UNAVAILABLE_USAGE_OUTPUTS;
  }
  const usage = sumUsage(entries);
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
 * workflow steps branch on the result. `null` means the status file was never
 * written — a setup or agent step crashed before reporting — and still yields
 * `failed: "true"` so `if: always()` consumers get a signal exactly when they
 * need it most.
 */
export function toActionOutputs(run: RunStatus | null): ActionOutputs {
  if (!run) {
    return {
      status: "",
      failed: "true",
      repaired: "false",
      comment_url: "",
      ...UNAVAILABLE_USAGE_OUTPUTS,
    };
  }
  return {
    // An off-vocabulary status is dropped, not escaped; `failed` derives from
    // the raw status (off-vocabulary is not in OK_STATUSES, so it fails), so
    // the gate can never launder a failure into a green-looking output.
    status: OUTPUT_STATUS_RE.test(run.status) ? run.status : "",
    failed: runFailsJob(run) ? "true" : "false",
    repaired: run.repaired ? "true" : "false",
    comment_url: run.commentUrl && OUTPUT_URL_RE.test(run.commentUrl) ? run.commentUrl : "",
    ...usageActionOutputs(run.usage),
  };
}

// Benign outcomes that stay green. `not-an-update-pr` is green because a
// human taking over an updater branch (or a non-dependency PR reaching the
// workflow) is expected, not a failure; `deferred` is green because the fixer
// declining an unsafe repair is the designed behavior and the report comment
// explains it; `publish-blocked` is green because the updater rebasing or the
// PR closing mid-run is normal churn. Everything else — including the
// `in-progress` marker the workflow writes up front (which only a graceful
// finish upgrades) and `verification-failed` (analysis ran but the PR remains
// red — the outcome users must notice) — fails the job.
const OK_STATUSES = new Set([
  "report-prepared",
  "repair-prepared",
  "not-an-update-pr",
  "deferred",
  "publish-blocked",
]);

/** Whether the run's status is a job-failing outcome. */
export function statusFailsJob(status: string): boolean {
  return !OK_STATUSES.has(status);
}

export function runFailsJob(run: RunStatus): boolean {
  return statusFailsJob(run.status);
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

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseUsageList(raw: unknown): OpUsage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const u = parseUsage(entry);
    return u ? [u] : [];
  });
}

function parseUsage(raw: unknown): OpUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Partial<OpUsage>;
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
  // like the payload), and the reporter exists to surface failures — so a
  // truncated/corrupt write or a non-object root must read as null (= no
  // status), the direction every caller already fails toward, not crash the
  // report before it can write its outputs.
  let parsed: Partial<RunStatus>;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    parsed = raw;
  } catch {
    return null;
  }
  const run: RunStatus = {
    status: typeof parsed.status === "string" ? parsed.status : "unknown",
    baseRef: typeof parsed.baseRef === "string" ? parsed.baseRef : null,
    headRef: typeof parsed.headRef === "string" ? parsed.headRef : null,
    headSha: typeof parsed.headSha === "string" ? parsed.headSha : null,
    prNumber:
      typeof parsed.prNumber === "number" && Number.isSafeInteger(parsed.prNumber)
        ? parsed.prNumber
        : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    changes: Array.isArray(parsed.changes) ? parsed.changes : [],
    verification: Array.isArray(parsed.verification) ? parsed.verification : [],
    repaired: parsed.repaired === true,
    commentUrl: typeof parsed.commentUrl === "string" ? parsed.commentUrl : null,
  };
  // Preserve the record-only fields across the publish read→rewrite round-trip;
  // this parser rebuilds the object field-by-field, so an omitted field would
  // be silently dropped when publish patches the outcome back in.
  if (Array.isArray(parsed.testChanges) && parsed.testChanges.length > 0) {
    run.testChanges = parsed.testChanges;
  }
  const usage = parseUsageList(parsed.usage);
  if (usage.length > 0) run.usage = usage;
  return run;
}

/**
 * Record the publish outcome from the token-holding publish step: patch the
 * status file without disturbing the analysis record. Returns null when the
 * status file is missing/unreadable — report-status's null path already
 * reports that as a failure.
 */
export function recordPublishOutcome(
  file: string,
  patch: Partial<Pick<RunStatus, "status" | "summary" | "commentUrl">>,
): RunStatus | null {
  const current = readRunStatus(file);
  if (!current) return null;
  const next: RunStatus = { ...current, ...patch };
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

function oneLine(value: string): string {
  return sanitizeSummary(value)
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/^\s*::/, ": :")
    .trim();
}

/** Run-level one-line summary for logs and the top annotation. */
export function runLogLine(run: RunStatus): string {
  const parts = [`status=${run.status}`];
  if (run.headRef) parts.push(`head=${run.headRef}`);
  if (run.baseRef) parts.push(`base=${run.baseRef}`);
  if (run.prNumber !== null) parts.push(`pr=#${run.prNumber}`);
  if (run.repaired) parts.push("repaired=true");
  if (run.commentUrl) parts.push(`comment=${run.commentUrl}`);
  const usage = sumUsage(run.usage);
  if (usage) parts.push(`tokens=${usage.totalTokens} cost=${fmtCost(usage.costUsd)}`);
  const summary = oneLine(run.summary);
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

function changesTable(changes: DependencyChange[]): string {
  if (changes.length === 0) return "";
  const rows = changes.map(
    (c) =>
      `| ${mdCell(c.name)} | ${mdCell(c.from)} | ${mdCell(c.to)} | ${mdCell(c.kind)} | ${mdCell(c.updateType)} |`,
  );
  return [
    "### Dependency changes",
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
  return ["### Verification", "", "| Result | Command | Exit |", "|---|---|---|", ...rows, ""].join(
    "\n",
  );
}

/**
 * A step-summary block flagging test files the repair changed, so a maintainer
 * sees it in the Actions UI as well as the report comment. Paths are charset-
 * validated (`isDisplayablePath`) before embedding, exactly like the comment;
 * any dropped for unsafe names are still counted.
 */
function testChangesTable(changes: NumstatEntry[]): string {
  if (changes.length === 0) return "";
  const safe = changes.filter((c) => isDisplayablePath(c.path));
  const omitted = changes.length - safe.length;
  const rows = safe.map((c) => `| \`${c.path}\` | ${formatNumstatLines(c)} |`);
  return [
    `### ⚠️ Tests modified by the repair (${changes.length})`,
    "",
    ...(rows.length > 0 ? ["| File | Lines |", "|---|---|", ...rows, ""] : []),
    ...(omitted > 0 ? [`_${omitted} file(s) with unsafe names omitted._`, ""] : []),
  ].join("\n");
}

export function renderStepSummary(run: RunStatus): string {
  const usage = sumUsage(run.usage);
  const rows = [
    `| Status | \`${mdCell(run.status)}\` |`,
    `| PR | ${run.prNumber !== null ? `#${run.prNumber}` : "none"} |`,
    `| Head | ${run.headRef ? `\`${mdCell(run.headRef)}\`` : "none"} |`,
    `| Base | ${run.baseRef ? `\`${mdCell(run.baseRef)}\`` : "none"} |`,
    `| Repaired | ${run.repaired ? "yes" : "no"} |`,
  ];
  if (run.commentUrl) rows.push(`| Report | ${mdCell(run.commentUrl)} |`);
  if (usage) {
    const cacheRead = usage.cacheRead > 0 ? ` · cache read ${fmtTokens(usage.cacheRead)}` : "";
    const cacheWrite = usage.cacheWrite > 0 ? ` · cache write ${fmtTokens(usage.cacheWrite)}` : "";
    const breakdown = (run.usage ?? [])
      .map((u) => `${u.role} ${fmtTokens(u.totalTokens)}`)
      .join(" + ");
    rows.push(
      `| LLM usage | ${fmtTokens(usage.totalTokens)} tokens (in ${fmtTokens(usage.input)} · out ${fmtTokens(usage.output)}${cacheRead}${cacheWrite}), est. ${fmtCost(usage.costUsd)} · ${breakdown} — \`${mdCell(usage.models.join(", "))}\` |`,
    );
  }
  return [
    "## depvisor",
    "",
    "| Field | Value |",
    "|---|---|",
    ...rows,
    "",
    "### Summary",
    "",
    mdCell(run.summary) || "No summary was emitted.",
    "",
    changesTable(run.changes),
    verificationTable(run.verification),
    testChangesTable(run.testChanges ?? []),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function appendStepSummary(file: string, run: RunStatus): void {
  appendFileSync(file, `${renderStepSummary(run)}\n`);
}
