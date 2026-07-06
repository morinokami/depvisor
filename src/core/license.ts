import type { Packument } from "./release-age.ts";
import type { Candidate } from "./types.ts";

/**
 * Deterministic, LLM-free detector for "did the declared license change between
 * the current and target version?" — a display-only sibling of
 * core/test-changes.ts, surfacing a review signal neither the scope gate nor the
 * verification gate can catch.
 *
 * A version bump can quietly carry a relicense (MIT -> BUSL-1.1 and the like are
 * common in practice); today the only thing that would surface it is the agent
 * happening to mention it in notable_changes. This reads the per-version
 * `license` string straight from the npm packument the run already fetched (for
 * the cooldown / source-repo links) and reports a plain string difference in the
 * PR body.
 *
 * Deliberately un-clever, matching the "never interpret" policy:
 *   - STRING COMPARISON ONLY. No SPDX parsing, no "did it get more restrictive?"
 *     judgment — that reading is a human's job. We only report that the label
 *     changed.
 *   - Only a plain-string `license` counts as KNOWN. The deprecated object form
 *     (`{ type, url }`), the ancient `licenses` array, and a missing field all
 *     read as "unknown", and an unknown side is never reported (fail-open):
 *     comparing an object-form "MIT" against a string-form "MIT" would otherwise
 *     manufacture a phantom change.
 *
 * Fail-open on purpose (the opposite of core/release-age.ts): this is display,
 * not a defense, so an unresolvable license shows nothing rather than blocking a
 * PR. The embed-boundary charset check lives in pr.ts, where the untrusted
 * (registry-derived) string is finally rendered.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The declared license of one published version, as a trimmed plain string, or
 * null when the packument records no clean string license for it (version
 * absent, object/array license form, or missing/blank field — all "unknown").
 */
export function versionLicense(packument: Packument, version: string): string | null {
  const versions = packument.versions;
  if (!versions || !Object.hasOwn(versions, version)) return null;
  const manifest = versions[version];
  if (!isRecord(manifest)) return null;
  const license = manifest.license;
  if (typeof license !== "string") return null;
  const trimmed = license.trim();
  return trimmed === "" ? null : trimmed;
}

export interface LicenseChange {
  name: string;
  from: string;
  to: string;
}

/** Distinct `current` versions to check for a member (Candidate.currents, or its
 * lowest), mirroring advisories.ts: in a workspace repo `current` is only the
 * LOWEST merged version, so a relicense carried by a higher-versioned workspace
 * (e.g. 2.0.0 GPL alongside 1.0.0 MIT, both moving to 3.0.0 MIT) would be missed
 * if we compared only `current`. npm/bun report every occurrence; pnpm collapses
 * them (same limitation as advisory matching). */
function memberCurrents(c: Candidate): string[] {
  const cs = c.currents && c.currents.length > 0 ? c.currents : [c.current];
  return [...new Set(cs.filter((v) => v.length > 0))];
}

/**
 * For each member, one LicenseChange per DISTINCT `from -> to` license pair where
 * the target and that workspace-current both record a KNOWN string license that
 * differs (input order; repeated `from` licenses across workspaces deduped, since
 * `to` is fixed per member). Members without a cached packument, or without a
 * clean string license on either side, are skipped (fail-open). Comparison is
 * exact string equality after trimming.
 */
export function classifyLicenseChanges(
  members: readonly Candidate[],
  packuments: ReadonlyMap<string, Packument | null>,
): LicenseChange[] {
  const changes: LicenseChange[] = [];
  for (const m of members) {
    const packument = packuments.get(m.name);
    if (!packument) continue;
    const to = versionLicense(packument, m.latest);
    if (to === null) continue;
    const seen = new Set<string>();
    for (const cur of memberCurrents(m)) {
      const from = versionLicense(packument, cur);
      if (from === null || from === to || seen.has(from)) continue;
      seen.add(from);
      changes.push({ name: m.name, from, to });
    }
  }
  return changes;
}

/**
 * Collapse a registry-derived license string to a single-line, length-capped
 * form safe for the CI log. Unlike the PR body (charset-gated in pr.ts), the log
 * is a raw stdout stream: an embedded newline could split the line so a
 * `::`-prefixed fragment is read as a GitHub Actions workflow command (a fake
 * annotation), and an unbounded string could flood the log. Control characters
 * (\p{Cc}, incl. CR/LF and the C1 block) become spaces, runs collapse, capped.
 */
function logSafeLicense(license: string): string {
  const collapsed = license
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

/**
 * One-line note for the run log — never silent, matching describeReleaseAge /
 * describeAdvisories. "" when nothing changed. License strings are control-
 * sanitized (see logSafeLicense) because they are untrusted registry data.
 */
export function describeLicenseChanges(changes: readonly LicenseChange[]): string {
  if (changes.length === 0) return "";
  const list = changes
    .map((c) => `${c.name} ${logSafeLicense(c.from)} -> ${logSafeLicense(c.to)}`)
    .join(", ");
  return `license change(s) detected: ${list}.`;
}
