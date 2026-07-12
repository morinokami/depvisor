import { isValidNpmName } from "./changelog.ts";
import { matchesPattern, parseNamePattern } from "./name-pattern.ts";
import type { Candidate } from "./types.ts";
import { parseVersionCore } from "./version-core.ts";

/**
 * The ignore policy: a deterministic, LLM-free filter applied right after
 * collect — BEFORE the minimum_release_age clamp and grouping — that drops
 * candidates a human has decided never to try. Without it an un-updatable
 * package (a major that clashes with the repo's Node constraint, a dependency
 * that went commercial, an intentional pin) keeps surfacing as a group and
 * burns an agent run (LLM cost) every scheduled run. This is the permanent,
 * human-decided counterpart to the transient defer / verification-failed
 * outcomes, which leave no memory and re-appear next run.
 *
 * Trust model matches verify_commands: the rules come from workflow config
 * (`ignore` input / DEPVISOR_IGNORE), never from the agent-writable target
 * tree. Syntax is deliberately minimal — depvisor carries no semver library, so
 * nothing here needs range satisfaction:
 *   - `name`          — always exclude this package.
 *   - `name@<major>`  — exclude only when the update target's major is <major>.
 *   - `prefix*`       — a trailing-`*` prefix glob (`@types/*`, `eslint-*`;
 *                       grammar in name-pattern.ts). Ignoring is where a glob
 *                       over-matching hurts most (updates silently stop), so
 *                       describeIgnore attributes every glob-dropped candidate
 *                       to its rule, and combining a glob with a major
 *                       (`@acme/*@3`) is NOT supported — it fails closed.
 *   - `# …`           — a full-line comment (npm names cannot start with `#`,
 *                       so this can never shadow a real rule). Trailing
 *                       comments after a rule are NOT supported — they fail
 *                       loudly like any other unrecognized entry.
 * Fuller ranges (`>=2 <3`) and update-type rules (`major`) are a future
 * expansion gated on adding a semver dependency. parseIgnore fails closed on
 * anything it does not recognize, so a typo turns the run red (`bad-ignore`)
 * rather than silently letting the "ignored" update through.
 *
 * Ordering note: because this runs before the cooldown clamp, a `name@<major>`
 * rule matches the raw registry `latest` reported by collect, not the
 * (possibly clamped) version that would actually be installed. That is the
 * conservative direction — a major the cooldown would have avoided anyway is
 * dropped a run early — and it keeps this a pure prepend filter that never has
 * to touch release-age's fail-closed "unavailable" path.
 */

/**
 * A parsed ignore rule: an exact name (bare, major null, or pinned to one
 * major), or a trailing-`*` prefix glob (which can never carry a major — the
 * union makes `@acme/*@3` unrepresentable, not just unparsed).
 */
export type IgnoreRule =
  | {
      name: string;
      /** null → match any update to this package; a number → only that target major. */
      major: number | null;
    }
  | {
      /** The stem of a trailing-`*` glob: `@types/*` is stored as `@types/`. */
      namePrefix: string;
    };

export type ParsedIgnore = { ok: true; rules: IgnoreRule[] } | { ok: false; invalid: string[] };

/** The leading major of an x.y.z core, matching collect.ts's loose parse. */
function latestMajor(version: string): number | null {
  return parseVersionCore(version)?.[0] ?? null;
}

/**
 * Parse one non-empty ignore entry, or null if unrecognized. The version
 * separator is the `@` that follows the package name; for a scoped name
 * (`@scope/pkg`) the leading `@` is part of the name, so the search starts
 * after the `/`. A major must be a bare non-negative integer — full versions
 * (`pkg@1.2.3`), ranges (`pkg@^1`), and an empty major (`pkg@`) are rejected.
 * An entry containing `*` is a prefix glob and takes no major: `@acme/*@3`
 * neither ends in `*` nor names a valid package, so it fails closed.
 */
function parseEntry(entry: string): IgnoreRule | null {
  if (entry.includes("*")) {
    const pattern = parseNamePattern(entry);
    return pattern && "namePrefix" in pattern ? { namePrefix: pattern.namePrefix } : null;
  }
  const scoped = entry.startsWith("@");
  const slash = entry.indexOf("/");
  if (scoped && slash === -1) return null; // `@foo` with no scope path
  const at = entry.indexOf("@", scoped ? slash + 1 : 0);
  if (at === -1) {
    return isValidNpmName(entry) ? { name: entry, major: null } : null;
  }
  const name = entry.slice(0, at);
  const majorStr = entry.slice(at + 1);
  if (!isValidNpmName(name)) return null;
  if (!/^\d+$/.test(majorStr)) return null;
  return { name, major: Number(majorStr) };
}

/**
 * Parse the newline-separated ignore input. Blank lines and full-line `#`
 * comments are skipped; every remaining line must parse, else the whole input
 * is rejected with the list of offending entries so the run can fail fast with
 * a message that names them (silently dropping a bad rule would be the
 * "thought I ignored it" trap).
 */
export function parseIgnore(raw: string): ParsedIgnore {
  const rules: IgnoreRule[] = [];
  const invalid: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const rule = parseEntry(entry);
    if (rule) rules.push(rule);
    else invalid.push(entry);
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, rules };
}

/**
 * The first rule that ignores this candidate (`name`, `name@<latest-major>`,
 * or a matching prefix glob), or null. Shared by the filter and by
 * describeIgnore's attribution so the summary names the rule that actually
 * fired, not just any rule that could have.
 */
function matchedRule(candidate: Candidate, rules: readonly IgnoreRule[]): IgnoreRule | null {
  const major = latestMajor(candidate.latest);
  for (const rule of rules) {
    if (!matchesPattern(candidate.name, rule)) continue;
    if ("namePrefix" in rule || rule.major === null) return rule;
    if (major !== null && major === rule.major) return rule;
  }
  return null;
}

/**
 * Split candidates into those to keep and those the ignore rules drop, in input
 * order. A pure prepend filter — no version rewriting, no updateType change —
 * so it never affects branch/PR identity: ignoring a package makes its
 * singleton group vanish, and shrinks a user-declared group (whose key derives
 * from the declared name, not from membership) without renaming it.
 */
export function applyIgnore(
  candidates: readonly Candidate[],
  rules: readonly IgnoreRule[],
): { kept: Candidate[]; ignored: Candidate[] } {
  if (rules.length === 0) return { kept: [...candidates], ignored: [] };
  const kept: Candidate[] = [];
  const ignored: Candidate[] = [];
  for (const c of candidates) {
    (matchedRule(c, rules) ? ignored : kept).push(c);
  }
  return { kept, ignored };
}

/**
 * One-line note for the run log and summary — ignoring is a deliberate config
 * choice (green), but echoing what it dropped confirms the rules took effect.
 * A candidate dropped by a prefix glob is attributed to its rule (`via
 * @types/*`), and a glob that matched NOTHING this run is reported too: a
 * glob's matches drift as the repo's dependencies do, so unlike an exact rule
 * the user cannot know them from the config alone, and a zero count is how a
 * typo'd stem (`@nope/*`) surfaces — the glob counterpart of the documented
 * "misspelled exact name excludes nothing" trap. "" only when the rules
 * include no glob and nothing was ignored.
 */
export function describeIgnore(
  ignored: readonly Candidate[],
  rules: readonly IgnoreRule[],
): string {
  const parts: string[] = [];
  if (ignored.length > 0) {
    const list = ignored
      .map((c) => {
        const rule = matchedRule(c, rules);
        const via = rule && "namePrefix" in rule ? ` (via ${rule.namePrefix}*)` : "";
        return `${c.name} ${c.current} -> ${c.latest}${via}`;
      })
      .join(", ");
    parts.push(`skipped ${list}`);
  }
  const unmatched: string[] = [];
  for (const rule of rules) {
    if ("namePrefix" in rule && !ignored.some((c) => c.name.startsWith(rule.namePrefix))) {
      unmatched.push(`${rule.namePrefix}*`);
    }
  }
  if (unmatched.length > 0) {
    parts.push(`${unmatched.join(", ")} matched no outdated candidate`);
  }
  return parts.length === 0 ? "" : `ignore: ${parts.join("; ")}.`;
}
