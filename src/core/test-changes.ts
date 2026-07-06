import type { NumstatEntry } from "./git.ts";

/**
 * Deterministic, LLM-free classifier for "does this changed path look like a
 * test?" — the visibility counterpart to `core/scope.ts`.
 *
 * The scope gate cannot DENY test files: adapting tests to an updated API is a
 * legitimate part of a dependency update, so a poisoned agent that weakens an
 * assertion to make verification pass takes exactly the same path a good update
 * does. That hole cannot be gated shut without stopping honest PRs, so instead
 * we surface it: classify the committed diff and, when tests changed, flag it in
 * the PR body and step summary so review attention lands where the gate cannot
 * vouch.
 *
 * The heuristic is worldwide naming convention ONLY. It deliberately does not
 * read the target's test-runner config (jest/vitest/etc.) to decide what counts
 * as a test: that config lives in the agent-writable tree and must not be trusted
 * to define the very thing we are auditing. Completeness is a non-goal — a
 * non-empty result means "these look like tests", never "these are all the tests
 * and nothing else was one".
 */
const TEST_PATH_RE: RegExp[] = [
  /(^|\/)__tests__\//,
  /(^|\/)__mocks__\//,
  /(^|\/)tests?\//, // test/ or tests/ as a path segment
  /(^|\/)spec\//,
  /(^|\/)e2e\//,
  /(^|\/)cypress\//,
  /(^|\/)playwright\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/, // foo.test.ts, foo.spec.jsx, foo.test.mjs
  /(^|\/)[^/]+_test\.[cm]?[jt]sx?$/, // Go/Python-style foo_test.ts
];

/** Whether a repo-relative path matches a common test-file convention. */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.some((re) => re.test(path));
}

/** The subset of a diff's entries whose paths look like tests. */
export function classifyTestChanges(entries: readonly NumstatEntry[]): NumstatEntry[] {
  return entries.filter((e) => isTestPath(e.path));
}

/** Render a numstat entry's line delta; binary files report null counts. */
export function formatNumstatLines(entry: NumstatEntry): string {
  if (entry.added === null || entry.removed === null) return "binary";
  return `+${entry.added} / -${entry.removed}`;
}
