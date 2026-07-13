/**
 * Bounded mergeability polling for the token-holding snapshot entrypoint.
 * GitHub computes mergeability lazily, so only depvisor PRs whose initial
 * snapshot explicitly says UNKNOWN are polled. Work is bounded independently
 * by rounds, global wall-clock deadline, and concurrency. A detail failure or
 * malformed response leaves only that PR UNKNOWN; the initial list remains the
 * fail-closed operation owned by the entrypoint.
 */

import {
  mergeabilityOf,
  normalizeRestMergeable,
  type SnapshotPrFields,
} from "./open-pr-snapshot.ts";

export interface PollOptions {
  maxAttempts: number;
  deadlineMs: number;
  concurrency: number;
  intervalMs: number;
}

export const DEFAULT_POLL_OPTIONS: PollOptions = {
  maxAttempts: 4,
  deadlineMs: 8_000,
  concurrency: 4,
  intervalMs: 350,
};

export type PullDetail = (number: number, timeoutMs: number) => Promise<unknown>;

function stillUnknown(entry: SnapshotPrFields): boolean {
  return mergeabilityOf(entry).mergeabilityUnknown;
}

function pollableUnknown(entry: SnapshotPrFields): boolean {
  return (
    entry.headRefName?.startsWith("depvisor/") === true &&
    typeof entry.number === "number" &&
    Number.isSafeInteger(entry.number) &&
    entry.number > 0 &&
    stillUnknown(entry)
  );
}

async function mapBounded<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker),
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUnknownMergeability(
  input: readonly SnapshotPrFields[],
  detail: PullDetail,
  options: PollOptions = DEFAULT_POLL_OPTIONS,
): Promise<SnapshotPrFields[]> {
  const entries = input.map((entry) => ({ ...entry }));
  const started = Date.now();
  const deadline = started + Math.max(0, options.deadlineMs);

  for (let attempt = 0; attempt < Math.max(0, options.maxAttempts); attempt += 1) {
    const pending = entries.filter(pollableUnknown);
    if (pending.length === 0 || Date.now() >= deadline) break;

    await mapBounded(pending, options.concurrency, async (entry) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      try {
        const raw = await detail(entry.number!, remaining);
        if (!raw || typeof raw !== "object" || !("mergeable" in raw)) return;
        entry.mergeable = normalizeRestMergeable((raw as { mergeable?: unknown }).mergeable);
      } catch {
        // Per-PR API and timeout failures are observations, not run gates.
      }
    });

    if (attempt + 1 >= options.maxAttempts) break;
    if (!entries.some(pollableUnknown)) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(Math.max(0, options.intervalMs), remaining));
  }
  return entries;
}
