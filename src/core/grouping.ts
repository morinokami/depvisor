import {
  describePattern,
  parseNamePattern,
  patternsOverlap,
  type NamePattern,
} from "./name-pattern.ts";
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
 * package simply being up to date, a prefix-glob member matching a package
 * that did not exist last run) refresh the same branch/PR instead of forging
 * a new identity. A declared group none of whose members has an update
 * simply does not appear. No preset bundles anything (`@types/*` included):
 * related-package bundling is exactly what the user-declared config is for,
 * never a heuristic.
 */

/**
 * One parsed `groups` rule: a stable group name and the member patterns it
 * bundles — exact package names or trailing-`*` prefix globs (name-pattern.ts).
 * Like every config knob, rules come from the workflow file/env (TRUSTED),
 * never from the agent-writable target tree.
 */
export interface GroupRule {
  name: string;
  packages: NamePattern[];
}

export type ParsedGroups = { ok: true; rules: GroupRule[] } | { ok: false; problems: string[] };

// The name is embedded in the group key, which slugify() maps to the branch
// name — so beyond slugify's identity charset (no `@`, nothing that maps to
// `-`) the name must also survive both transforms intact:
//   - start AND end alphanumeric: slugify() trims trailing `-` (so `foo` and
//     `foo-` would collide on one branch — across runs, where the
//     branch-collision guard cannot see it), and git rejects a ref component
//     ending in `.`;
//   - no `..` and no `.lock` suffix: git rejects both in a ref
//     (`git check-ref-format --branch`), and accepting them here would defer
//     the failure to ensureBranch() mid-run — possibly runs later, once the
//     group first clears the open_pull_requests_limit ceiling.
// This keeps the group-name → branch mapping total and injective without
// shelling out to git from the parser.
const GROUP_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isValidGroupName(name: string): boolean {
  return GROUP_NAME_RE.test(name) && !name.includes("..") && !name.endsWith(".lock");
}

/**
 * Parse the newline-separated `groups` input. Each line is
 * `<group-name>: <member> <member> …` (members separated by spaces and/or
 * commas); blank lines and full-line `#` comments are skipped. A member is an
 * exact package name or a trailing-`*` prefix glob (name-pattern.ts). Every
 * problem is collected and the whole input rejected on any (the "thought I
 * grouped it" trap is the same as ignore's), with fail-closed rules for the
 * identity-sensitive parts: duplicate group names, a member repeated verbatim
 * anywhere, and any pair of members from DIFFERENT groups that could match
 * the same package (`react` vs `react*`, `@acme/*` vs `@acme/ui-*`) are
 * rejected rather than resolved by precedence, because either would make PR
 * identity depend on rule order. The overlap check is deliberately static —
 * pattern against pattern, at parse time, never against collected candidates
 * — so a config's validity can never flip run-to-run as new packages appear.
 * Within ONE group, an exact member covered by that group's own glob is
 * allowed: it is redundant, not ambiguous.
 */
export function parseGroups(raw: string): ParsedGroups {
  const rules: GroupRule[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  const claimedBy = new Map<string, string>();
  const patterns: { pattern: NamePattern; group: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const colon = entry.indexOf(":");
    if (colon === -1) {
      problems.push(`'${entry}' has no ':' between the group name and its packages`);
      continue;
    }
    const name = entry.slice(0, colon).trim();
    if (!isValidGroupName(name)) {
      problems.push(
        `group name '${name}' must use only letters, digits, '.', '_', and '-', start and ` +
          "end with a letter or digit, and contain no '..' or trailing '.lock' (it becomes " +
          "part of the branch name)",
      );
      continue;
    }
    if (names.has(name)) {
      problems.push(`group '${name}' is declared more than once`);
      continue;
    }
    const packages: NamePattern[] = [];
    let bad = false;
    for (const pkg of entry
      .slice(colon + 1)
      .split(/[\s,]+/)
      .filter(Boolean)) {
      const pattern = parseNamePattern(pkg);
      if (!pattern) {
        problems.push(
          `'${pkg}' in group '${name}' is not a valid package name or trailing-'*' prefix glob`,
        );
        bad = true;
        continue;
      }
      const key = describePattern(pattern);
      const owner = claimedBy.get(key);
      if (owner !== undefined) {
        problems.push(`'${key}' is listed more than once ('${owner}' and '${name}')`);
        bad = true;
        continue;
      }
      const clash = patterns.find((p) => p.group !== name && patternsOverlap(p.pattern, pattern));
      if (clash) {
        problems.push(
          `'${key}' in group '${name}' overlaps '${describePattern(clash.pattern)}' in group ` +
            `'${clash.group}' — a package matching both would belong to two groups`,
        );
        bad = true;
        continue;
      }
      claimedBy.set(key, name);
      patterns.push({ pattern, group: name });
      packages.push(pattern);
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
  // Glob members expand here, against the candidates of THIS run — parseGroups
  // already rejected every cross-group overlap, so each candidate name can
  // match members of at most one group and the lookup order cannot matter.
  const declaredExact = new Map<string, string>();
  const declaredPrefix: { prefix: string; group: string }[] = [];
  for (const rule of rules) {
    for (const pkg of rule.packages) {
      if ("name" in pkg) declaredExact.set(pkg.name, rule.name);
      else declaredPrefix.push({ prefix: pkg.namePrefix, group: rule.name });
    }
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
    const declared =
      declaredExact.get(c.name) ?? declaredPrefix.find((p) => c.name.startsWith(p.prefix))?.group;
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

  return [...groups.values()].toSorted((a, b) => a.key.localeCompare(b.key));
}
