import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeSummary } from "./pr.ts";
import type { Candidate } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

export const RUN_STATUS_FILE = "status.json";

export interface StatusPackage {
  name: string;
  current: string;
  latest: string;
  kind: Candidate["kind"];
  updateType: Candidate["updateType"];
}

export interface RunStatus {
  status: string;
  branch: string | null;
  base: string | null;
  group: string | null;
  summary: string;
  packages: StatusPackage[];
  verification: VerifyResult[];
  prUrl: string | null;
}

// Benign no-PR outcomes stay green. `open-pr-blocked` is here because a human
// having taken over the PR branch (which makes depvisor refuse to force-push)
// is expected, not a failure — see open-pr.ts.
const OK_STATUSES = new Set([
  "pr-prepared",
  "pr-up-to-date",
  "no-updates",
  "deferred",
  "open-pr-blocked",
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

export function readRunStatus(file: string): RunStatus | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RunStatus>;
  return {
    status: String(parsed.status ?? "unknown"),
    branch: typeof parsed.branch === "string" ? parsed.branch : null,
    base: typeof parsed.base === "string" ? parsed.base : null,
    group: typeof parsed.group === "string" ? parsed.group : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    packages: Array.isArray(parsed.packages) ? (parsed.packages as StatusPackage[]) : [],
    verification: Array.isArray(parsed.verification) ? (parsed.verification as VerifyResult[]) : [],
    prUrl: typeof parsed.prUrl === "string" ? parsed.prUrl : null,
  };
}

export function updateRunStatus(file: string, patch: Partial<RunStatus>): RunStatus | null {
  const current = readRunStatus(file);
  if (!current) return null;
  const next: RunStatus = { ...current, ...patch };
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export function statusFailsJob(status: string): boolean {
  return !OK_STATUSES.has(status);
}

export function statusAnnotationLevel(status: string): "notice" | "error" {
  return statusFailsJob(status) ? "error" : "notice";
}

function oneLine(value: string): string {
  return sanitizeSummary(value)
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/^\s*::/, ": :")
    .trim();
}

export function statusLogLine(status: RunStatus): string {
  const parts = [`status=${status.status}`];
  if (status.branch) parts.push(`branch=${status.branch}`);
  if (status.group) parts.push(`group=${status.group}`);
  if (status.prUrl) parts.push(`pr=${status.prUrl}`);
  const summary = oneLine(status.summary);
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
    "### Packages",
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

export function renderStepSummary(status: RunStatus): string {
  const rows = [
    `| Status | \`${mdCell(status.status)}\` |`,
    `| Branch | ${status.branch ? `\`${mdCell(status.branch)}\`` : "none"} |`,
    `| Base | ${status.base ? `\`${mdCell(status.base)}\`` : "none"} |`,
    `| Group | ${status.group ? `\`${mdCell(status.group)}\`` : "none"} |`,
  ];
  if (status.prUrl) rows.push(`| PR | ${mdCell(status.prUrl)} |`);

  return [
    "## depvisor",
    "",
    "| Field | Value |",
    "|---|---|",
    ...rows,
    "",
    "### Summary",
    "",
    mdCell(status.summary) || "No summary was emitted.",
    "",
    packageTable(status.packages),
    verificationTable(status.verification),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function appendStepSummary(file: string, status: RunStatus): void {
  appendFileSync(file, `${renderStepSummary(status)}\n`);
}
