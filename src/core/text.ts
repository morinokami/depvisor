/**
 * Bounded-text helpers shared by the modules that hand process output or
 * target output across the verifier-to-fixer boundary.
 */

// The fixer only needs the END of a failing command's log to diagnose it; the
// same budget applies to every configured command.
const TAIL_MAX = 4000;

/** The last `max` characters of `s` — the end of a log names the failure. */
export function tail(s: string, max = TAIL_MAX): string {
  return s.length <= max ? s : s.slice(-max);
}
