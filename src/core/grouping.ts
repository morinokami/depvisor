import type { Candidate, Group } from "./types.ts";

/**
 * Assign candidates to groups with stable keys. The key becomes the branch/PR
 * identity, so it must not depend on which members happen to be present in a
 * given run — hence keys like `types`, `dev-minor`, or `major/<name>`, not
 * member-list hashes.
 *
 * Layering:
 *   1. major updates           → isolated for individual review
 *   2. @types/* preset         → grouped
 *   3. remaining dev deps       → grouped to reduce noise
 *   4. remaining prod deps      → individual (conservative default)
 *
 * Hard lockstep families (@babel/*, peer-dep pairs, …) need dependency-graph
 * analysis before they can be grouped safely.
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
    if (c.name.startsWith("@types/")) {
      add("types", "type-definition packages grouped together", c);
      continue;
    }
    if (c.kind === "dev") {
      add("dev-minor", "non-major dev-dependency updates grouped to reduce PR noise", c);
      continue;
    }
    add(`prod/${c.name}`, "production dependency updated individually (conservative default)", c);
  }

  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
