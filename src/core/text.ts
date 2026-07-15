/**
 * Bounded-text helper for handing process output across a boundary (the
 * fixer prompt's failure tails). A tiny leaf, in the style of version-core.ts.
 */

// The fixer only needs the END of a failing command's log to diagnose it;
// this one budget bounds verify.ts's step tails, which feed the fixer-prompt
// diagnostics.
const TAIL_MAX = 4000;

/** The last `max` characters of `s` — the end of a log names the failure. */
export function tail(s: string, max = TAIL_MAX): string {
  return s.length <= max ? s : s.slice(-max);
}
