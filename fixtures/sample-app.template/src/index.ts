import chalk from "chalk";
import * as semver from "semver";
import LRU from "lru-cache";

/** Returns a colored greeting. Uses chalk (v4 API). */
export function greet(name: string): string {
  return chalk.green(`Hello, ${name}!`);
}

/** Returns true when `a` is a newer semver than `b`. */
export function isNewer(a: string, b: string): boolean {
  return semver.gt(a, b);
}

// lru-cache v7 default-import API. This import breaks on the next major, where
// the default export was removed in favor of the named `LRUCache` export.
const cache = new LRU<string, string>({ max: 100 });

/** Memoize greetings in an LRU cache. */
export function cachedGreet(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const value = greet(name);
  cache.set(name, value);
  return value;
}
