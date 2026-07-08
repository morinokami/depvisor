import type { Candidate, Group } from "./types.ts";

/**
 * Assign candidates to groups with stable keys. The key becomes the branch/PR
 * identity, so it derives from the candidate's name/kind/updateType — never
 * from which other members happen to be present in a given run.
 *
 * Every group is a singleton: one package, one PR (vanilla Dependabot's model).
 * Layering:
 *   1. major updates    → major/<name> (isolated for individual review)
 *   2. dev deps         → dev/<name>
 *   3. prod deps        → prod/<name>
 *
 * No preset bundles anything (`@types/*` included): related-package bundling
 * is a future user-declared `groups` config, not a heuristic.
 */
export function groupCandidates(candidates: Candidate[]): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, reason: string, c: Candidate) => {
    let g = groups.get(key);
    if (!g) {
      g = { key, reason, members: [] };
      groups.set(key, g);
    }
    g.members.push(c);
  };

  for (const c of candidates) {
    // 'unknown' means the current/latest pair is unparseable or latest is not
    // ahead (prerelease in use, MISSING install) — "update to latest" could be
    // a downgrade, so these never reach the agent.
    if (c.updateType === "unknown") continue;
    if (c.updateType === "major") {
      add(`major/${c.name}`, "major update isolated for individual review", c);
      continue;
    }
    if (c.kind === "dev") {
      add(`dev/${c.name}`, "dev dependency updated individually", c);
      continue;
    }
    add(`prod/${c.name}`, "production dependency updated individually", c);
  }

  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
