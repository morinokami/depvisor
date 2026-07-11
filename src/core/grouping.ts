import { isValidNpmName } from "./changelog.ts";
import type { Candidate, Group } from "./types.ts";

/**
 * Assign candidates to groups with stable keys. The key becomes the branch/PR
 * identity, so it derives from configuration and the candidate's own
 * name/kind/updateType — never from which other members happen to be present
 * in a given run.
 *
 * Layering:
 *   1. user-declared groups → group/<group-name> (the `groups` input; all
 *      update types, majors included — the user said these move together)
 *   2. major updates       → major/<name> (isolated for individual review)
 *   3. dev deps            → dev/<name>
 *   4. prod deps           → prod/<name>
 *
 * A user-declared group's key comes from its declared NAME alone, so members
 * entering or leaving a run (a cooldown clamp maturing, an `ignore` rule, a
 * package simply being up to date) refresh the same branch/PR instead of
 * forging a new identity. A declared group none of whose members has an update
 * simply does not appear. No preset bundles anything (`@types/*` included):
 * related-package bundling is exactly what the user-declared config is for,
 * never a heuristic.
 */

/**
 * One parsed `groups` rule: a stable group name and the exact package names it
 * bundles. Like every config knob, rules come from the workflow file/env
 * (TRUSTED), never from the agent-writable target tree.
 */
export interface GroupRule {
  name: string;
  packages: string[];
}

export type ParsedGroups = { ok: true; rules: GroupRule[] } | { ok: false; problems: string[] };

// The name is embedded in the group key, which slugify() maps to the branch
// name — restricting it to slugify's identity charset (no `@`, nothing that
// maps to `-`) keeps distinct group names on distinct branches by construction.
const GROUP_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Parse the newline-separated `groups` input. Each line is
 * `<group-name>: <package> <package> …` (members separated by spaces and/or
 * commas); blank lines and full-line `#` comments are skipped. The grammar is
 * deliberately minimal — exact package names only, no globs — matching the
 * exact-string stance of every other list knob. Every problem is collected and
 * the whole input rejected on any (the "thought I grouped it" trap is the same
 * as ignore's), with fail-closed rules for the identity-sensitive parts:
 * duplicate group names and a package claimed by two groups (or twice by one)
 * are rejected rather than resolved by precedence, because either would make
 * PR identity depend on rule order.
 */
export function parseGroups(raw: string): ParsedGroups {
  const rules: GroupRule[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  const claimedBy = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const colon = entry.indexOf(":");
    if (colon === -1) {
      problems.push(`'${entry}' has no ':' between the group name and its packages`);
      continue;
    }
    const name = entry.slice(0, colon).trim();
    if (!GROUP_NAME_RE.test(name)) {
      problems.push(
        `group name '${name}' must use only letters, digits, '.', '_', and '-' (it becomes part of the branch name)`,
      );
      continue;
    }
    if (names.has(name)) {
      problems.push(`group '${name}' is declared more than once`);
      continue;
    }
    const packages: string[] = [];
    let bad = false;
    for (const pkg of entry
      .slice(colon + 1)
      .split(/[\s,]+/)
      .filter(Boolean)) {
      if (!isValidNpmName(pkg)) {
        problems.push(`'${pkg}' in group '${name}' is not a valid package name`);
        bad = true;
        continue;
      }
      const owner = claimedBy.get(pkg);
      if (owner !== undefined) {
        problems.push(`package '${pkg}' is listed more than once ('${owner}' and '${name}')`);
        bad = true;
        continue;
      }
      claimedBy.set(pkg, name);
      packages.push(pkg);
    }
    if (packages.length === 0 && !bad) {
      problems.push(`group '${name}' lists no packages`);
      continue;
    }
    names.add(name);
    rules.push({ name, packages });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rules };
}

export function groupCandidates(
  candidates: Candidate[],
  rules: readonly GroupRule[] = [],
): Group[] {
  const declaredGroup = new Map<string, string>();
  for (const rule of rules) {
    for (const pkg of rule.packages) declaredGroup.set(pkg, rule.name);
  }

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
    // a downgrade, so these never reach the agent, declared in a group or not.
    if (c.updateType === "unknown") continue;
    const declared = declaredGroup.get(c.name);
    if (declared !== undefined) {
      add(`group/${declared}`, `user-declared group '${declared}'`, c);
      continue;
    }
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
