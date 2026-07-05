import chalk from "chalk";
import * as semver from "semver";

// chalk v4 ships a CommonJS default export. v5 is ESM-only, which breaks this
// `commonjs` build until the code migrates to a dynamic import.
/** Returns a colored greeting. */
export function greet(name: string): string {
  return chalk.green(`Hello, ${name}!`);
}

/** Colour a version green when it is ahead of the baseline, yellow otherwise. */
export function versionLabel(version: string, baseline: string): string {
  return semver.gt(version, baseline) ? chalk.green(version) : chalk.yellow(version);
}
