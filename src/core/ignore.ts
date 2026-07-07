import { isValidNpmName } from "./changelog.ts";
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

/** A parsed ignore rule: a bare name (major null) or a name pinned to one major. */
export interface IgnoreRule {
  name: string;
  /** null → match any update to this package; a number → only that target major. */
  major: number | null;
}

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
 */
function parseEntry(entry: string): IgnoreRule | null {
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

/** True when any rule ignores this candidate (`name`, or `name@<latest-major>`). */
function isIgnored(candidate: Candidate, rules: readonly IgnoreRule[]): boolean {
  const major = latestMajor(candidate.latest);
  for (const rule of rules) {
    if (rule.name !== candidate.name) continue;
    if (rule.major === null) return true;
    if (major !== null && major === rule.major) return true;
  }
  return false;
}

/**
 * Split candidates into those to keep and those the ignore rules drop, in input
 * order. A pure prepend filter — no version rewriting, no updateType change —
 * so it never affects branch/PR identity beyond removing members (an aggregate
 * group like `dev-minor` keeps its key; a singleton group simply vanishes).
 */
export function applyIgnore(
  candidates: readonly Candidate[],
  rules: readonly IgnoreRule[],
): { kept: Candidate[]; ignored: Candidate[] } {
  if (rules.length === 0) return { kept: [...candidates], ignored: [] };
  const kept: Candidate[] = [];
  const ignored: Candidate[] = [];
  for (const c of candidates) {
    (isIgnored(c, rules) ? ignored : kept).push(c);
  }
  return { kept, ignored };
}

/**
 * One-line note for the run log — ignoring is a deliberate config choice (green),
 * but echoing what it dropped confirms the rules took effect. "" when nothing
 * was ignored.
 */
export function describeIgnore(ignored: readonly Candidate[]): string {
  if (ignored.length === 0) return "";
  const list = ignored.map((c) => `${c.name} ${c.current} -> ${c.latest}`).join(", ");
  return `ignore: skipped ${list}.`;
}
