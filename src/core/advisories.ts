import type { Candidate, Group } from "./types.ts";

/**
 * Security prioritization (deterministic, LLM-free, unit-tested): query OSV.dev
 * for known advisories affecting each candidate's CURRENT version, and decide
 * which update groups RESOLVE at least one advisory (current affected, target
 * not). Those groups are stable-promoted to the front of the processing order,
 * so a run's max_prs budget spends its slots on security fixes first.
 *
 * This is an OPTIMIZATION, not a defense, so — unlike release-age.ts — it is
 * FAIL-SOFT: any fetch/parse failure degrades to "no advisory known" and the
 * neutral localeCompare order (changelog.ts's never-throw stance). It never
 * changes which version is installed (that stays release-age.ts's clamp), only
 * the ORDER groups are processed, so branch/PR identity is untouched.
 *
 * The resolve check runs against the candidate's `latest` AS SEEN HERE, which
 * is post-clamp (minimum_release_age runs before grouping): a fix version still
 * inside the cooldown window is not yet the target, so its group is not promoted
 * until the fix matures. Cooldown wins over urgency by construction.
 */

const OSV_API = "https://api.osv.dev";

// Hung OSV degrades to "no advisory known" (neutral order) instead of stalling
// the run, mirroring changelog.ts / release-age.ts.
const FETCH_TIMEOUT_MS = 10_000;

// --- version comparison, release-age.ts's parseCore/compareTriple in spirit ---
// OSV SEMVER boundaries are concrete versions ("4.18.0") or the "0" sentinel
// (the very first version), NEVER npm range expressions ("^4.0.0"), so ordering
// needs only version COMPARISON — no range parser, no semver library. Prerelease
// suffixes collapse to their x.y.z core, the same limitation release-age.ts
// already accepts; here it fails toward "still affected", i.e. no promotion.
type Triple = [number, number, number];

function parseCore(v: string): Triple | null {
  if (v === "0") return [0, 0, 0]; // OSV sentinel: introduced at the beginning
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareCore(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The slice of an OSV vulnerability the resolve check reads. */
interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
interface OsvRange {
  type?: string;
  events?: OsvEvent[];
}
interface OsvAffected {
  package?: { ecosystem?: string; name?: string };
  ranges?: OsvRange[];
  versions?: string[];
}
export interface OsvVuln {
  id?: string;
  aliases?: string[];
  affected?: OsvAffected[];
}

// GHSA ids are GHSA-xxxx-xxxx-xxxx (a lowercase base32 subset). pr.ts re-validates
// the same shape at the PR-body embed boundary; keeping the check here too means
// the unit that promotes a group is exactly the id the PR can link.
const GHSA_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

/**
 * The advisory's GHSA id, from its primary `id` or its `aliases` (OSV may key a
 * record by CVE and alias the GHSA, or the reverse). null when it has no GHSA —
 * rare for npm, where GitHub mints a GHSA for essentially every advisory. We
 * deliberately promote and display in GHSA terms so the promotion unit is
 * identical to what the PR body's Security column links; a GHSA-less advisory is
 * simply not counted rather than promoting a group with nothing to show.
 */
function extractGhsa(vuln: Record<string, unknown>): string | null {
  if (typeof vuln.id === "string" && GHSA_RE.test(vuln.id)) return vuln.id;
  if (Array.isArray(vuln.aliases)) {
    for (const a of vuln.aliases) if (typeof a === "string" && GHSA_RE.test(a)) return a;
  }
  return null;
}

type Boundary = { kind: "introduced" | "fixed" | "last_affected"; core: Triple };

/**
 * Whether `core` is affected by one OSV SEMVER range. Returns null (unknown)
 * for a non-SEMVER range or an unparseable boundary — the caller treats unknown
 * conservatively (no promotion). OSV reference matching: sort the boundaries and
 * a version is affected iff the newest boundary at-or-before it is an
 * `introduced` (not a `fixed`/`last_affected`), which handles disjoint
 * introduced/fixed intervals in one fold.
 */
function rangeAffects(core: Triple, range: OsvRange): boolean | null {
  if (range?.type !== "SEMVER") return null;
  const boundaries: Boundary[] = [];
  for (const e of Array.isArray(range.events) ? range.events : []) {
    let raw: string | undefined;
    let kind: Boundary["kind"];
    if (typeof e?.introduced === "string") {
      raw = e.introduced;
      kind = "introduced";
    } else if (typeof e?.fixed === "string") {
      raw = e.fixed;
      kind = "fixed";
    } else if (typeof e?.last_affected === "string") {
      raw = e.last_affected;
      kind = "last_affected";
    } else {
      continue;
    }
    const c = parseCore(raw);
    if (!c) return null; // unparseable boundary → cannot decide
    boundaries.push({ kind, core: c });
  }
  if (boundaries.length === 0) return null;
  boundaries.sort((a, b) => compareCore(a.core, b.core));
  let affected = false;
  for (const b of boundaries) {
    const cmp = compareCore(core, b.core);
    if (b.kind === "introduced") {
      if (cmp >= 0) affected = true;
    } else if (b.kind === "fixed") {
      if (cmp >= 0) affected = false;
    } else if (cmp > 0) {
      affected = false; // last_affected: affected THROUGH this version, fixed after
    }
  }
  return affected;
}

/**
 * Whether `version` of `name` is affected by `vuln`. Only npm affected entries
 * for the exact name count. true as soon as any range (or the explicit
 * `versions` list) matches; false when every range is evaluable and none match;
 * null when a range could not be evaluated at all (unknown type / unparseable),
 * so the caller fails toward "still affected".
 */
function versionAffected(name: string, version: string, vuln: OsvVuln): boolean | null {
  const core = parseCore(version);
  if (!core) return null;
  let sawUnknown = false;
  for (const a of Array.isArray(vuln.affected) ? vuln.affected : []) {
    if (a?.package?.ecosystem !== "npm" || a.package.name !== name) continue;
    if (Array.isArray(a.versions) && a.versions.includes(version)) return true;
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      const res = rangeAffects(core, r);
      if (res === null) sawUnknown = true;
      else if (res) return true;
    }
  }
  return sawUnknown ? null : false;
}

/**
 * True when updating `name` from `current` to `latest` RESOLVES this advisory:
 * the current version is affected and the target is not. `latest` is the
 * post-clamp target the workflow will actually install, so a fix still inside
 * the minimum_release_age window does not count (cooldown wins). Any version the
 * matcher cannot evaluate fails toward "still affected", so a group is never
 * promoted on a maybe.
 */
export function resolvesAdvisory(
  name: string,
  current: string,
  latest: string,
  vuln: OsvVuln,
): boolean {
  return (
    versionAffected(name, current, vuln) === true && versionAffected(name, latest, vuln) === false
  );
}

function requestInit(body: unknown, signal: AbortSignal | undefined): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "depvisor",
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
}

/** POST to a fixed OSV endpoint; null on any failure (fail-soft — no throw). */
async function osvPost(
  doFetch: typeof fetch,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    const res = await doFetch(`${OSV_API}${path}`, requestInit(body, signal));
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export interface AdvisoryResult {
  /** Package name → the advisory ids (GHSA) the current→latest update resolves. */
  resolvedByPackage: Map<string, string[]>;
  /** false when the OSV lookup hit a hard failure — the run keeps neutral order. */
  ok: boolean;
}

/**
 * Look up advisories resolved by each candidate's update. Two fixed endpoints:
 * one `/v1/querybatch` triages every candidate at its CURRENT version (returns
 * ids only), then only the packages that have an advisory are fetched in full
 * via `/v1/query` (affected ranges included) and evaluated against both current
 * and post-clamp latest. Fail-soft throughout: a querybatch failure yields
 * `ok:false` (neutral order); a single package's `/v1/query` failure just leaves
 * that package unpromoted.
 */
export async function fetchAdvisories(
  candidates: readonly Candidate[],
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AdvisoryResult> {
  const resolvedByPackage = new Map<string, string[]>();
  // 'unknown'-typed candidates are never grouped/updated, so they cannot be
  // promoted; skip them (and their query cost).
  const updatable = candidates.filter((c) => c.updateType !== "unknown");
  if (updatable.length === 0) return { resolvedByPackage, ok: true };
  const doFetch = opts.fetch ?? fetch;
  const signal = opts.signal;

  // 1. Triage: one querybatch for every candidate at its CURRENT version.
  const batch = await osvPost(
    doFetch,
    "/v1/querybatch",
    {
      queries: updatable.map((c) => ({
        package: { ecosystem: "npm", name: c.name },
        version: c.current,
      })),
    },
    signal,
  );
  const results = isRecord(batch) && Array.isArray(batch.results) ? batch.results : null;
  if (!results) return { resolvedByPackage, ok: false };
  const vulnerable = updatable.filter((_, i) => {
    const r = results[i];
    return isRecord(r) && Array.isArray(r.vulns) && r.vulns.length > 0;
  });

  // 2. Full fetch per vulnerable package; evaluate current vs post-clamp latest.
  //    A full query that fails or is malformed leaves the OSV snapshot
  //    incomplete for a package querybatch already flagged as vulnerable.
  //    Ordering on a partial snapshot would silently mis-rank the max_prs slots,
  //    so — matching the fail-soft "on any lookup failure use the neutral order
  //    and log" rule — bail to ok:false + empty map instead of a quiet success.
  const perPackage = await Promise.all(
    vulnerable.map(async (c) => {
      const full = await osvPost(
        doFetch,
        "/v1/query",
        { package: { ecosystem: "npm", name: c.name }, version: c.current },
        signal,
      );
      if (!isRecord(full) || !Array.isArray(full.vulns)) return null; // failed / malformed
      const ids: string[] = [];
      for (const raw of full.vulns) {
        if (!isRecord(raw)) continue;
        // Count and display in GHSA terms; raw is guarded field-by-field inside
        // resolvesAdvisory.
        const ghsa = extractGhsa(raw);
        if (ghsa && resolvesAdvisory(c.name, c.current, c.latest, raw as unknown as OsvVuln)) {
          ids.push(ghsa);
        }
      }
      return { name: c.name, ids: [...new Set(ids)].sort() };
    }),
  );
  if (perPackage.some((r) => r === null)) return { resolvedByPackage: new Map(), ok: false };
  for (const r of perPackage) {
    if (r && r.ids.length > 0) resolvedByPackage.set(r.name, r.ids);
  }
  return { resolvedByPackage, ok: true };
}

/**
 * Stable-promote groups whose update resolves an advisory to the front of the
 * processing order, preserving the input (localeCompare) order within each rank.
 * Ordering ONLY — group keys and membership are untouched, so branch/PR identity
 * is unchanged. `Array.prototype.sort` is stable (Node 22), so equal ranks keep
 * their relative order.
 */
export function prioritizeGroups(
  groups: readonly Group[],
  resolvedByPackage: ReadonlyMap<string, string[]>,
): Group[] {
  const resolvesAny = (g: Group): boolean =>
    g.members.some((m) => (resolvedByPackage.get(m.name)?.length ?? 0) > 0);
  return [...groups].sort((a, b) => Number(resolvesAny(b)) - Number(resolvesAny(a)));
}

/** One-line run-summary note; "" when nothing was prioritized. */
export function describeAdvisories(resolvedByPackage: ReadonlyMap<string, string[]>): string {
  if (resolvedByPackage.size === 0) return "";
  const parts = [...resolvedByPackage.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, ids]) => `${name} (${ids.join(", ")})`);
  const n = parts.length;
  return `security: prioritized ${n} update${n === 1 ? "" : "s"} resolving known advisories: ${parts.join("; ")}.`;
}
