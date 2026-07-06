/**
 * The x.y.z "version core" primitives shared by every module that orders
 * versions. depvisor deliberately carries no semver library: wherever versions
 * must be compared, only the numeric x.y.z core is parsed and ordered, and each
 * consumer anchors its parse to match the shape of ITS input:
 *
 *   - `parseVersionCore` (here, unanchored): version strings from the registry
 *     and `outdated` output. `outdated` reports the `latest` dist-tag verbatim,
 *     and when a maintainer points it at a prerelease (e.g. 2.0.0-rc.1) that
 *     exact string is what the update installs — so it still classifies from
 *     its x.y.z core instead of being dropped. Used by collect.ts, ignore.ts,
 *     and release-age.ts's clamp bounds.
 *   - release-age.ts's `parseStable` (fully anchored): the clamp set must never
 *     contain a prerelease, which the core comparator cannot order.
 *   - advisories.ts's `parseOsvVersion` (start-anchored, plus OSV's "0"
 *     sentinel): OSV boundaries are bare concrete versions, never tags.
 *   - changelog.ts's `parseSemver` (end-anchored): a release tag's prerelease
 *     suffix (`v11.0.0-beta.1`) must not parse as its GA version and land in a
 *     release-note window.
 */

export type Triple = [number, number, number];

/** The first x.y.z core anywhere in the string, or null (see the doc above). */
export function parseVersionCore(v: string): Triple | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareTriple(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
