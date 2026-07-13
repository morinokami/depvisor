/**
 * Parse the conflict_refresh_only input. This mode is intended for dependency-
 * state push triggers: it may rebuild conflicted existing depvisor PRs, but it
 * must never turn the newly freed PR slot into a new PR. The value comes only
 * from trusted workflow configuration, never from the target tree or PR body.
 */
export function parseConflictRefreshOnly(raw: string): boolean | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "false") return false;
  if (trimmed === "true") return true;
  return null;
}
