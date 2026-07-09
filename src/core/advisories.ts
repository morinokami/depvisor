import type { Candidate, Group } from "./types.ts";
import { compareTriple, type Triple } from "./version-core.ts";

/**
 * Security prioritization (deterministic, LLM-free, unit-tested): query OSV.dev
 * for known advisories affecting each candidate's CURRENT version, and decide
 * which update groups RESOLVE at least one advisory (current affected, target
 * not). Those groups are stable-promoted to the front of the processing order,
 * so a run's open_pull_requests_limit budget spends its slots on security fixes first.
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

// OSV SEMVER boundaries are concrete versions ("4.18.0") or the "0" sentinel
// (the very first version), NEVER npm range expressions ("^4.0.0"), so ordering
// needs only version COMPARISON — no range parser, no semver library. Prerelease
// suffixes collapse to their x.y.z core, the same limitation release-age.ts
// already accepts; here it fails toward "still affected", i.e. no promotion.
// Start-anchored, unlike version-core.ts's loose parse: OSV boundaries are bare
// versions, never tags, so a leading-garbage string is unparseable on purpose.
function parseOsvVersion(v: string): Triple | null {
  if (v === "0") return [0, 0, 0]; // OSV sentinel: introduced at the beginning
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
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
    const c = parseOsvVersion(raw);
    if (!c) return null; // unparseable boundary → cannot decide
    boundaries.push({ kind, core: c });
  }
  if (boundaries.length === 0) return null;
  boundaries.sort((a, b) => compareTriple(a.core, b.core));
  let affected = false;
  for (const b of boundaries) {
    const cmp = compareTriple(core, b.core);
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
  const core = parseOsvVersion(version);
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

/** Distinct `current` versions to probe for a candidate (Candidate.currents, or its lowest). */
function candidateCurrents(c: Candidate): string[] {
  const cs = c.currents && c.currents.length > 0 ? c.currents : [c.current];
  return [...new Set(cs.filter((v) => v.length > 0))];
}

/**
 * Look up advisories resolved by each candidate's update. Two fixed endpoints:
 * one `/v1/querybatch` triages every candidate at EACH of its declared
 * `current` versions (returns ids only), then the (name, current) pairs that
 * have an advisory are fetched in full via `/v1/query` (affected ranges
 * included) and evaluated — that current is affected AND the post-clamp latest
 * is not. Probing every workspace-current, not just the lowest, is what stops a
 * vulnerability that only a higher-versioned workspace carries from being hidden
 * behind the merged lowest. Fail-soft: a querybatch failure OR any flagged
 * pair's `/v1/query` failure/malformed shape yields `ok:false` + empty map (the
 * workflow logs it and keeps the neutral order) — never a quiet success on a
 * partial snapshot.
 */
export async function fetchAdvisories(
  candidates: readonly Candidate[],
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AdvisoryResult> {
  const resolvedByPackage = new Map<string, string[]>();
  // 'unknown'-typed candidates are never grouped/updated, so they cannot be
  // promoted; skip them (and their query cost).
  const updatable = candidates.filter((c) => c.updateType !== "unknown");
  // One probe per (candidate, distinct current) — usually one current per
  // candidate; workspace monorepos can declare several.
  const probes = updatable.flatMap((c) => candidateCurrents(c).map((current) => ({ c, current })));
  if (probes.length === 0) return { resolvedByPackage, ok: true };
  const doFetch = opts.fetch ?? fetch;
  const signal = opts.signal;

  // 1. Triage: one querybatch over every probe.
  const batch = await osvPost(
    doFetch,
    "/v1/querybatch",
    {
      queries: probes.map((p) => ({
        package: { ecosystem: "npm", name: p.c.name },
        version: p.current,
      })),
    },
    signal,
  );
  // The querybatch contract is exactly one result per query, each an object
  // ({} when the package is clean). A length mismatch or a non-object element
  // means the fixed API drifted; bail to the neutral order rather than silently
  // treating the gap as "clean" (same fail-soft stance as a hard fetch failure).
  const results = isRecord(batch) && Array.isArray(batch.results) ? batch.results : null;
  if (!results || results.length !== probes.length || !results.every(isRecord)) {
    return { resolvedByPackage, ok: false };
  }
  const hot = probes.filter((_, i) => {
    const r = results[i];
    return isRecord(r) && Array.isArray(r.vulns) && r.vulns.length > 0;
  });

  // 2. Full fetch per flagged (name, current) pair; evaluate that current vs the
  //    post-clamp latest. A failure/malformed shape here bails to ok:false (see
  //    the doc above) rather than ordering on a partial snapshot.
  const perProbe = await Promise.all(
    hot.map(async ({ c, current }) => {
      const full = await osvPost(
        doFetch,
        "/v1/query",
        { package: { ecosystem: "npm", name: c.name }, version: current },
        signal,
      );
      if (!isRecord(full) || !Array.isArray(full.vulns)) return null; // failed / malformed
      const ids: string[] = [];
      for (const raw of full.vulns) {
        if (!isRecord(raw)) continue;
        // Count and display in GHSA terms; raw is guarded field-by-field inside
        // resolvesAdvisory.
        const ghsa = extractGhsa(raw);
        if (ghsa && resolvesAdvisory(c.name, current, c.latest, raw as unknown as OsvVuln)) {
          ids.push(ghsa);
        }
      }
      return { name: c.name, ids };
    }),
  );
  if (perProbe.some((r) => r === null)) return { resolvedByPackage: new Map(), ok: false };

  // Merge per package (a package with several affected workspace-currents yields
  // several probes), deduping ids.
  const idsByPackage = new Map<string, Set<string>>();
  for (const r of perProbe) {
    if (!r || r.ids.length === 0) continue;
    const set = idsByPackage.get(r.name) ?? new Set<string>();
    for (const id of r.ids) set.add(id);
    idsByPackage.set(r.name, set);
  }
  for (const [name, set] of idsByPackage) resolvedByPackage.set(name, [...set].sort());
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

/**
 * Run-summary/log note for an OSV outage. Fail-soft keeps the run green, so
 * this note is the only user-visible trace of the degradation (the workflow
 * appends it to the completed run's summary, which report-status renders into
 * the step summary and the run-level annotation). Without it, a permanently
 * unreachable api.osv.dev — e.g. an egress allowlist that predates the
 * endpoint — would silently disable security prioritization on every run,
 * discoverable only by reading the raw agent-step log.
 */
export const ADVISORIES_UNAVAILABLE_NOTE =
  "Security prioritization was unavailable (OSV.dev could not be queried): groups ran in " +
  "the neutral order and PRs may be missing their Security column. If this note appears " +
  "on every run, check that api.osv.dev is reachable from the runner (e.g. your egress " +
  "allowlist).";

/** One-line run-summary note; "" when nothing was prioritized. */
export function describeAdvisories(resolvedByPackage: ReadonlyMap<string, string[]>): string {
  if (resolvedByPackage.size === 0) return "";
  const parts = [...resolvedByPackage.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, ids]) => `${name} (${ids.join(", ")})`);
  const n = parts.length;
  return `security: prioritized ${n} update${n === 1 ? "" : "s"} resolving known advisories: ${parts.join("; ")}.`;
}
