import * as semver from "semver";
import LRU from "lru-cache";

/** Returns true when `a` is a newer semver than `b`. */
export function isNewer(a: string, b: string): boolean {
  return semver.gt(a, b);
}

// lru-cache v7 default-import API. This import breaks on the next major, where
// the default export was removed in favor of the named `LRUCache` export.
const cache = new LRU<string, string>({ max: 100 });

/** Memoize a computed value in an LRU cache. */
export function remember(key: string, make: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  cache.set(key, value);
  return value;
}
