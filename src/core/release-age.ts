import { isValidNpmName } from "./changelog.ts";
import { classifyUpdate } from "./collect.ts";
import type { Candidate, UpdateType } from "./types.ts";
import { compareTriple, parseVersionCore, type Triple } from "./version-core.ts";

/**
 * The minimum_release_age cooldown: a deterministic, LLM-free supply-chain
 * time defense applied right after collect. The collectors report the `latest`
 * dist-tag verbatim, which a compromised release reaches the moment it is
 * published; this module rounds each candidate down to the newest version that
 * is BOTH newer than `current` AND at least `minDays` old on the npm registry
 * (Renovate's minimumReleaseAge / Dependabot's cooldown model).
 *
 * The fail policy is fail-closed: a candidate whose publish times cannot be
 * verified (registry unreachable, 404 — e.g. a private-registry package) is
 * dropped from the run and reported red (`release-age-unavailable`). This is
 * the deliberate opposite of changelog.ts's never-throw style — that module
 * is display-only, this one is a defense, and waving a candidate through on
 * error would defeat it. Private-registry users disable the cooldown with
 * `minimum_release_age: 0`.
 */

const NPM_REGISTRY = "https://registry.npmjs.org";

// Hung registries degrade to "unavailable" (a red drop) instead of stalling
// the run; one budget per packument, mirroring changelog.ts.
const FETCH_TIMEOUT_MS = 10_000;

const DAY_MS = 86_400_000;

/**
 * Parse the minimum_release_age input (days): empty = 1 (the default, matching
 * pnpm's minimumReleaseAge); "0" explicitly disables the cooldown; otherwise a
 * non-negative integer, else null (same shape as budget.ts's parseMaxPrs).
 */
export function parseMinReleaseAge(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return 1;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The slice of an npm packument the cooldown (and PR-body source links) needs. */
export interface Packument {
  time?: Record<string, unknown>;
  versions?: Record<string, unknown>;
  repository?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Fetch a package's packument from the fixed npm registry endpoint. Only the
 * endpoint is fixed here; callers supply nothing but the package name, and an
 * invalid name never leaves the process. Returns null on any failure — the
 * CALLER decides what null means (here: fail-closed drop), unlike
 * changelog.ts, where the same null is a benign "no links".
 */
export async function fetchPackument(
  pkg: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Packument | null> {
  if (!isValidNpmName(pkg)) return null;
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${NPM_REGISTRY}/${pkg}`, {
      headers: { accept: "application/json", "user-agent": "depvisor" },
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const meta: unknown = await res.json();
    if (!isRecord(meta)) return null;
    const packument: Packument = {};
    if (isRecord(meta.time)) packument.time = meta.time;
    if (isRecord(meta.versions)) packument.versions = meta.versions;
    if ("repository" in meta) packument.repository = meta.repository;
    return packument;
  } catch {
    return null;
  }
}

/**
 * Publish time (ms since epoch) per version, from a packument. The `time`
 * keys are intersected with the `versions` keys, which drops the
 * `created`/`modified` bookkeeping entries and — importantly — unpublished
 * versions, whose `time` entries linger after the version itself is gone.
 * Unparseable dates are dropped (their versions become unprovably mature).
 */
export function versionTimes(packument: Packument): Map<string, number> {
  const out = new Map<string, number>();
  const { time, versions } = packument;
  if (!time || !versions) return out;
  for (const [version, iso] of Object.entries(time)) {
    if (!Object.hasOwn(versions, version)) continue;
    if (typeof iso !== "string") continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    out.set(version, t);
  }
  return out;
}

// Stable-only, fully anchored: the clamp set must never contain a prerelease —
// `2.0.0-rc.1` and `2.0.0` share an x.y.z core, so the core comparator cannot
// order them. The loose `parseVersionCore` is used only for the current/latest
// BOUNDS, matching how collect.ts classifies (a prerelease `latest` bounds the
// clamp set by its core).
function parseStable(v: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export type ClampDecision =
  | { action: "keep" }
  | { action: "clamp"; latest: string; updateType: UpdateType }
  | { action: "exclude" };

/**
 * Decide one candidate's fate under the cooldown. A mature `latest` (its exact
 * version string is at least minDays old) passes verbatim — this is also the
 * only way a prerelease `latest` survives, since the stable-only clamp set
 * cannot order prereleases. Otherwise clamp to the newest mature STABLE
 * version in (current, latest] — bounds compared on x.y.z cores — recomputing
 * updateType because grouping (and so branch/PR identity) depends on it. No
 * mature version in the window means no update has ripened yet: exclude.
 * A version missing from `times` cannot be proven mature, so it never counts
 * as mature (fail-closed).
 */
export function clampCandidate(
  candidate: Candidate,
  minDays: number,
  nowMs: number,
  times: ReadonlyMap<string, number>,
): ClampDecision {
  const minMs = minDays * DAY_MS;
  const isMature = (t: number | undefined): t is number => t !== undefined && nowMs - t >= minMs;
  if (isMature(times.get(candidate.latest))) return { action: "keep" };
  const cur = parseVersionCore(candidate.current);
  const lat = parseVersionCore(candidate.latest);
  // Unparseable bounds cannot be clamped against. Candidates like these are
  // 'unknown'-typed and applyReleaseAge passes them through before calling
  // here; this is only a defensive backstop.
  if (!cur || !lat) return { action: "exclude" };
  let best: string | null = null;
  let bestParsed: Triple | null = null;
  for (const [version, t] of times) {
    if (!isMature(t)) continue;
    const parsed = parseStable(version);
    if (!parsed) continue;
    if (compareTriple(parsed, cur) <= 0 || compareTriple(parsed, lat) > 0) continue;
    if (!bestParsed || compareTriple(parsed, bestParsed) > 0) {
      best = version;
      bestParsed = parsed;
    }
  }
  if (best === null) return { action: "exclude" };
  return { action: "clamp", latest: best, updateType: classifyUpdate(candidate.current, best) };
}

export interface ReleaseAgeResult {
  /** Candidates to continue with (clamped ones already rewritten), input order. */
  kept: Candidate[];
  /** Kept, but rounded down from a too-new dist-tag `latest`. */
  clamped: { name: string; from: string; to: string }[];
  /** Dropped: no version newer than `current` has matured yet (normal, green). */
  excluded: Candidate[];
  /** Dropped: publish times unverifiable (fail-closed — reported red). */
  unavailable: Candidate[];
}

/**
 * Apply the cooldown to every candidate. Packuments are fetched once per
 * package into `opts.packuments`, which the caller can hold on to and reuse
 * (the PR body's source-repo links read the same packument), so one run never
 * fetches a package's packument twice. 'unknown'-typed candidates pass
 * through unfetched — grouping already excludes them from agent work, and a
 * red "unavailable" drop for a candidate that was never updatable would be
 * noise. `now` is injectable for test determinism.
 */
export async function applyReleaseAge(
  candidates: readonly Candidate[],
  minDays: number,
  opts: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    now?: number;
    packuments?: Map<string, Packument | null>;
  } = {},
): Promise<ReleaseAgeResult> {
  const result: ReleaseAgeResult = { kept: [], clamped: [], excluded: [], unavailable: [] };
  if (minDays <= 0) {
    result.kept = [...candidates];
    return result;
  }
  const nowMs = opts.now ?? Date.now();
  const packuments = opts.packuments ?? new Map<string, Packument | null>();
  const fetchOpts: { fetch?: typeof fetch; signal?: AbortSignal } = {};
  if (opts.fetch) fetchOpts.fetch = opts.fetch;
  if (opts.signal) fetchOpts.signal = opts.signal;

  const names = [
    ...new Set(
      candidates
        .filter((c) => c.updateType !== "unknown" && !packuments.has(c.name))
        .map((c) => c.name),
    ),
  ];
  await Promise.all(
    names.map(async (name) => {
      packuments.set(name, await fetchPackument(name, fetchOpts));
    }),
  );

  for (const c of candidates) {
    if (c.updateType === "unknown") {
      result.kept.push(c);
      continue;
    }
    const packument = packuments.get(c.name);
    const times = packument ? versionTimes(packument) : new Map<string, number>();
    if (times.size === 0) {
      result.unavailable.push(c);
      continue;
    }
    const decision = clampCandidate(c, minDays, nowMs, times);
    if (decision.action === "keep") {
      result.kept.push(c);
    } else if (decision.action === "clamp") {
      result.clamped.push({ name: c.name, from: c.latest, to: decision.latest });
      result.kept.push({ ...c, latest: decision.latest, updateType: decision.updateType });
    } else {
      result.excluded.push(c);
    }
  }
  return result;
}

/**
 * One-line note for the run summary — clamps and hold-backs are normal
 * operation (green) but must never be silent truncation. "" when the cooldown
 * changed nothing. Unavailable drops additionally get their own red group
 * entries in the workflow; this line is just the aggregate.
 */
export function describeReleaseAge(result: ReleaseAgeResult, minDays: number): string {
  const parts: string[] = [];
  if (result.clamped.length > 0) {
    const list = result.clamped.map((c) => `${c.name} to ${c.to} (latest ${c.from} is too new)`);
    parts.push(`clamped ${list.join(", ")}`);
  }
  if (result.excluded.length > 0) {
    const list = result.excluded.map((c) => `${c.name} ${c.latest}`);
    parts.push(`held back ${list.join(", ")} (no newer stable version is old enough)`);
  }
  if (result.unavailable.length > 0) {
    const list = result.unavailable.map((c) => c.name);
    parts.push(`dropped ${list.join(", ")} (release age unverifiable)`);
  }
  if (parts.length === 0) return "";
  return `minimum_release_age=${minDays}: ${parts.join("; ")}.`;
}
