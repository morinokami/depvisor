import type { V2Status } from "./types.ts";

const NEUTRAL = new Set<V2Status>([
  "no-target",
  "not-updater",
  "policy-skipped",
  "updater-refresh-requested",
  "stale-base",
  "stale-head",
  "human-takeover",
]);

const GREEN = new Set<V2Status>(["reviewed", "repair-not-needed", "repair-applied"]);

export type StatusClass = "neutral" | "green" | "red";

export function statusClass(status: V2Status): StatusClass {
  if (NEUTRAL.has(status)) return "neutral";
  if (GREEN.has(status)) return "green";
  return "red";
}

export function statusFailsJob(status: V2Status): boolean {
  return statusClass(status) === "red";
}
