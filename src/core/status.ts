/** Small v2 status contract: one run always describes one updater PR. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./json.ts";

export const RUN_STATUSES = [
  "in-progress",
  "reviewed",
  "repair-published",
  "deferred",
  "unsupported-pr",
  "setup-failed",
  "wrong-head",
  "agent-failed",
  "dependency-state-changed",
  "stale-pr",
  "publish-failed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

const STATUSES: ReadonlySet<string> = new Set(RUN_STATUSES);

function isRunStatus(value: string): value is RunStatus {
  return STATUSES.has(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  model: string;
}

export interface RunRecord {
  version: 2;
  status: RunStatus;
  summary: string;
  prUrl: string;
  repaired: boolean;
  commitSha: string | null;
  commentUrl: string | null;
  changedFiles: string[];
  usage: UsageRecord | null;
}

const GREEN = new Set<RunStatus>([
  "reviewed",
  "repair-published",
  "deferred",
  "unsupported-pr",
  "stale-pr",
]);

export function statusFails(status: RunStatus): boolean {
  return !GREEN.has(status);
}

export function writeRunRecord(path: string, record: RunRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2));
}

export function readRunRecord(path: string): RunRecord | null {
  if (!existsSync(path)) return null;
  if (statSync(path).size > 1024 * 1024) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw)) return null;
    const value = raw;
    if (value.version !== 2 || typeof value.status !== "string" || !isRunStatus(value.status)) {
      return null;
    }
    const usage = parseUsage(value.usage);
    return {
      version: 2,
      status: value.status,
      summary: typeof value.summary === "string" ? value.summary : "",
      prUrl: typeof value.prUrl === "string" ? value.prUrl : "",
      repaired: value.repaired === true,
      commitSha: typeof value.commitSha === "string" ? value.commitSha : null,
      commentUrl: typeof value.commentUrl === "string" ? value.commentUrl : null,
      changedFiles: Array.isArray(value.changedFiles)
        ? value.changedFiles.filter((file): file is string => typeof file === "string")
        : [],
      usage,
    };
  } catch {
    return null;
  }
}

function parseUsage(value: unknown): UsageRecord | null {
  if (!isRecord(value)) return null;
  const usage = value;
  if (
    !nonnegative(usage.input) ||
    !nonnegative(usage.output) ||
    !nonnegative(usage.cacheRead) ||
    !nonnegative(usage.cacheWrite) ||
    !nonnegative(usage.totalTokens) ||
    !nonnegative(usage.costUsd) ||
    !Number.isSafeInteger(usage.totalTokens) ||
    typeof usage.model !== "string"
  ) {
    return null;
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    model: usage.model,
  };
}

export function initialRecord(status: RunStatus, summary: string, prUrl = ""): RunRecord {
  return {
    version: 2,
    status,
    summary,
    prUrl,
    repaired: false,
    commitSha: null,
    commentUrl: null,
    changedFiles: [],
    usage: null,
  };
}
