/**
 * Numeric x.y.z comparison for the bounded npm release-note collector.
 */

export type Triple = [number, number, number];

export function compareTriple(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
