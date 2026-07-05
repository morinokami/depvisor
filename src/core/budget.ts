/**
 * The max_prs budget: deterministic, LLM-free decisions the update workflow
 * makes per group. `max_prs` is a ceiling on the number of open depvisor PRs
 * (Dependabot's open-pull-requests-limit model), not a per-run throughput cap:
 * a run opens new PRs only up to the ceiling, but always refreshes existing ones
 * (a refresh never consumes a slot). Extracted here so it is unit-testable
 * without the agent (the workflow module cannot be imported under plain node).
 */

/** Parse the max_prs input: empty = 1; otherwise a positive integer, else null. */
export function parseMaxPrs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return 1;
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
 *   - `refresh`: an open PR exists but its versions drifted — re-run (no slot).
 *   - `open-new`: no open PR and a slot is free — open a new PR (consumes a slot).
 *   - `held-back`: no open PR and the ceiling is reached — wait for a slot.
 */
export type GroupDisposition = "skip-up-to-date" | "refresh" | "open-new" | "held-back";

export function classifyGroup(args: {
  hasOpenPr: boolean;
  upToDate: boolean;
  newSlots: number;
}): GroupDisposition {
  if (args.hasOpenPr) return args.upToDate ? "skip-up-to-date" : "refresh";
  return args.newSlots > 0 ? "open-new" : "held-back";
}
