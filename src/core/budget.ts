/**
 * The open_pull_requests_limit budget: deterministic, LLM-free decisions the update workflow
 * makes per group. `open_pull_requests_limit` is a ceiling on the number of open depvisor PRs
 * (Dependabot's open-pull-requests-limit model), not a per-run throughput cap:
 * a run opens new PRs only up to the ceiling, but always refreshes existing ones
 * (a refresh never consumes a slot). Extracted here so it is unit-testable
 * without the agent (the workflow module cannot be imported under plain node).
 */

/**
 * Parse the open_pull_requests_limit input: empty = 5 (Dependabot's open-pull-requests-limit
 * default — every group is a single package, so 1 would throttle to one package
 * per merge); otherwise a positive integer, else null.
 */
export function parseOpenPullRequestsLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return 5;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Number of open PRs on a depvisor-owned branch, from the open-PR snapshot. */
export function countOpenDepvisorPrs(openBranches: Iterable<string>): number {
  return [...openBranches].filter((b) => b.startsWith("depvisor/")).length;
}

/**
 * What to do with a group this run:
 *   - `skip-up-to-date`: an open PR already covers exactly these target versions.
 *   - `refresh`: an open PR's versions drifted or it conflicts with base — re-run (no slot).
 *   - `open-new`: no open PR and a slot is free — open a new PR (consumes a slot).
 *   - `held-back`: no open PR and the ceiling is reached — wait for a slot.
 */
export type GroupDisposition = "skip-up-to-date" | "refresh" | "open-new" | "held-back";
export type RefreshReason = "target-drift" | "base-conflict";

export function classifyGroup(args: {
  hasOpenPr: boolean;
  upToDate: boolean;
  conflicted?: boolean;
  newSlots: number;
}): GroupDisposition {
  if (args.hasOpenPr) return args.upToDate && !args.conflicted ? "skip-up-to-date" : "refresh";
  return args.newSlots > 0 ? "open-new" : "held-back";
}

/**
 * Closed-world selection for dependency-state push runs. Non-conflicting open
 * PRs (even drifted ones) and groups with no open PR are excluded before
 * advisory lookup, budgeting, status accounting, or any per-group work.
 */
export function selectedForConflictRefreshOnly(args: {
  conflictRefreshOnly: boolean;
  hasOpenPr: boolean;
  conflicted: boolean;
}): boolean {
  return !args.conflictRefreshOnly || (args.hasOpenPr && args.conflicted);
}
