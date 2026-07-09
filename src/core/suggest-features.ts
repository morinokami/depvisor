/**
 * The suggest_features knob: a deterministic, LLM-free parse of the opt-in flag
 * that turns on the agent's "new-feature suggestions" behavior. When on, the
 * per-group prompt asks the agent to cross-reference newly added capabilities
 * from the release notes it ALREADY fetched for the update against real symbols
 * in the target codebase and report the relevant ones in an extra structured
 * field, which the workflow renders as a display-only PR-body section (never a
 * gate, never adopted — see core/pr.ts's newFeaturesSection).
 *
 * The default is off: the reason for opt-in is cost (and a wider exposure to
 * untrusted release notes, since suggesting encourages reading notes even on
 * minor updates), so an unset flag must do no extra work. Following the env
 * "empty string = not set" convention, the value is trimmed, then `""` or
 * `"false"` mean off and `"true"` means on; anything else is fail-closed
 * (`null` → the run stops with `bad-suggest-features`), mirroring the other
 * config knobs (parseOpenPullRequestsLimit / parseMinimumReleaseAge / parseIgnore) so a typo
 * fails loudly now rather than silently leaving the feature off.
 */
export function parseSuggestFeatures(raw: string): boolean | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "false") return false;
  if (trimmed === "true") return true;
  return null;
}
