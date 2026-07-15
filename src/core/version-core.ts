/**
 * The x.y.z "version core" primitives shared by every module that orders
 * versions. depvisor deliberately carries no semver library: wherever versions
 * must be compared, only the numeric x.y.z core is parsed and ordered, and each
 * consumer anchors its parse to match the shape of ITS input:
 *
 *   - `parseVersionCore` (here, unanchored): lockfile-resolved versions and
 *     manifest specifiers from the updater's diff — a range like `^11.2.1` or
 *     a prerelease like `2.0.0-rc.1` still classifies from its x.y.z core
 *     instead of being dropped. Used by dep-diff.ts's `classifyUpdate` and
 *     version ordering.
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
