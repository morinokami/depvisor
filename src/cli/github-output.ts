import { appendFileSync } from "node:fs";

/** Resolve/normalize jobs emit only single-line machine values. */
export function setGitHubOutput(name: string, value: string | number | boolean): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const text = String(value);
  if (!/^[A-Za-z0-9._:/-]*$/.test(text)) throw new Error(`unsafe GitHub output value for ${name}`);
  appendFileSync(path, `${name}=${text}\n`);
}
