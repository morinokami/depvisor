/**
 * Bounded-text helpers shared by the modules that hand process output or
 * registry text across a boundary (the fixer prompt, the CI log, status
 * summaries). A tiny leaf, in the style of version-core.ts.
 */

// The fixer only needs the END of a failing command's log to diagnose it; the
// same budget bounds verify.ts's step tails and bump.ts's command tails, which
// feed the same fixer-prompt diagnostics.
const TAIL_MAX = 4000;

/** The last `max` characters of `s` — the end of a log names the failure. */
export function tail(s: string, max = TAIL_MAX): string {
  return s.length <= max ? s : s.slice(-max);
}

/**
 * Collapse untrusted text to a single-line, length-capped form safe for the CI
 * log and status summaries. Unlike the PR body (charset-gated in pr.ts), the
 * log is a raw stdout stream: an embedded newline could split the line so a
 * `::`-prefixed fragment is read as a GitHub Actions workflow command (a fake
 * annotation), and an unbounded string could flood the log. Control characters
 * (\p{Cc}, incl. CR/LF and the C1 block) become spaces, whitespace runs
 * collapse, and the result is capped with an ellipsis.
 */
export function logSafeText(s: string, max: number): string {
  const collapsed = s
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
