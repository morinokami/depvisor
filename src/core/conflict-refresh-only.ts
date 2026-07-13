/**
 * Parse the conflict_refresh_only input. This mode is intended for dependency-
 * state push triggers: it may rebuild conflicted existing depvisor PRs, but it
 * must never turn the newly freed PR slot into a new PR. The value comes only
 * from trusted workflow configuration, never from the target tree or PR body.
 *
 * At the env level an empty value means false (local/non-action runs), but the
 * composite action defaults the input to `github.event_name == 'push'`, so a
 * push-triggered Action run gets this mode unless the workflow overrides it —
 * merging one depvisor PR must repair its conflicted siblings, not spawn a new
 * PR the user never scheduled. An unrecognized value is `bad-conflict-refresh-only`.
 */
export function parseConflictRefreshOnly(raw: string): boolean | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "false") return false;
  if (trimmed === "true") return true;
  return null;
}
