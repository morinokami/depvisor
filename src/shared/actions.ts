import { appendFileSync } from "node:fs";

/** Append one pre-validated name=value pair to the step's GITHUB_OUTPUT file. */
export function writeOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}
