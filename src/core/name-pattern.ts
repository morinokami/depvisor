import { isValidNpmName } from "./changelog.ts";

/**
 * The shared package-name pattern grammar for the three list knobs (`ignore`,
 * `minimum_release_age_exclude`, `groups`): an exact npm name, or a
 * trailing-`*` prefix glob (`@types/*`, `@acme/*`, `eslint-*`). Real
 * repositories move whole families of packages together, and expanded
 * exact-name lists rot — a new `@acme/new-package` fails the run
 * (`release-age-unavailable`) until someone remembers the depvisor workflow —
 * so the knobs accept the one glob form whose semantics need no matcher
 * library: a pure string prefix.
 *
 * Deliberately NOT supported, fail-closed like every other unrecognized entry:
 * a `*` anywhere but the end, `?`, character classes, and a scoped glob whose
 * scope is itself partial (`@acme*`) — that last one would silently cross
 * scope boundaries (`@acme/x` AND `@acme-tools/y`), the kind of over-match the
 * exact-only stance existed to prevent. A bare `*` (match everything) is
 * rejected for the same reason. Patterns only ever match against the candidate
 * names collect returned — no registry queries — so a glob can never introduce
 * a package the run would not otherwise have seen.
 */
export type NamePattern =
  | { name: string }
  /** The stem of a trailing-`*` glob — everything before the `*`. */
  | { namePrefix: string };

// Stems are prefixes of names in npm grammar (see changelog.ts's NPM_NAME_RE):
// an unscoped stem is a non-empty partial name; a scoped stem is a COMPLETE
// scope followed by `/` and an optionally-empty partial name.
const UNSCOPED_STEM_RE = /^[a-z0-9-~][a-z0-9-._~]*$/i;
const SCOPED_STEM_RE = /^@[a-z0-9-~][a-z0-9-._~]*\/(?:[a-z0-9-~][a-z0-9-._~]*)?$/i;

/**
 * Parse one entry as an exact name or a trailing-`*` prefix glob, or null if
 * it is neither (the caller reports it and fails the whole input closed).
 */
export function parseNamePattern(entry: string): NamePattern | null {
  if (!entry.includes("*")) {
    return isValidNpmName(entry) ? { name: entry } : null;
  }
  if (!entry.endsWith("*")) return null;
  const stem = entry.slice(0, -1);
  if (stem.includes("*")) return null;
  const re = stem.startsWith("@") ? SCOPED_STEM_RE : UNSCOPED_STEM_RE;
  return re.test(stem) ? { namePrefix: stem } : null;
}

/** True when the pattern matches this package name. */
export function matchesPattern(name: string, pattern: NamePattern): boolean {
  return "name" in pattern ? pattern.name === name : name.startsWith(pattern.namePrefix);
}

/** The pattern as the user wrote it (`lodash`, `@types/*`) — for messages. */
export function describePattern(pattern: NamePattern): string {
  return "name" in pattern ? pattern.name : `${pattern.namePrefix}*`;
}

/**
 * True when some package name could match both patterns. Exact/exact is
 * equality, exact/prefix is a prefix test, and two prefix globs overlap
 * exactly when one stem is a prefix of the other. Used by parseGroups to
 * reject cross-group ambiguity STATICALLY — at parse time, before collect —
 * so a `groups` config can never be valid one run and `bad-groups` the next
 * just because a new package appeared.
 */
export function patternsOverlap(a: NamePattern, b: NamePattern): boolean {
  if ("name" in a) return matchesPattern(a.name, b);
  if ("name" in b) return matchesPattern(b.name, a);
  return a.namePrefix.startsWith(b.namePrefix) || b.namePrefix.startsWith(a.namePrefix);
}

/**
 * The names among `names` that match at least one pattern. This is the
 * post-collect expansion step: deterministic, over the collected candidate
 * names only. A pattern matching nothing is normal (the documented
 * misspelled-name behavior, unchanged) — the caller's summary line is what
 * makes a zero-match visible.
 */
export function expandPatterns(
  patterns: readonly NamePattern[],
  names: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    if (patterns.some((p) => matchesPattern(name, p))) out.add(name);
  }
  return out;
}
