/**
 * Machine-readable reviewed-head state line in the maintained PR comment.
 *
 * The publisher records which PR head a no-repair review covered so a later
 * run triggered by another green CI completion of the same head can skip a
 * duplicate model review. The line lives in an editable PR comment, so it is
 * never trusted for anything stronger than suppressing that duplicate work:
 * a forged or deleted line at worst skips or re-runs one informational
 * review, and a non-success CI conclusion always bypasses the skip.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./json.ts";

export const REPORT_MARKER = "<!-- depvisor-v2-report -->";

interface ReportState {
  headSha: string;
  conclusion: string;
  generator: string;
}

const SHA = /^[0-9a-f]{40}$/;
const CONCLUSION = /^[a-z][a-z_-]{0,31}$/;
const GENERATOR = /^depvisor(@v\d+\.\d+\.\d+)?$/;

// Anchored to a whole line: agent prose cannot produce one because
// cleanReportText escapes HTML comment markers before the body is assembled.
const STATE_LINE =
  /^<!-- depvisor-v2-state sha:([0-9a-f]{40}) ci:([a-z][a-z_-]{0,31}) generator:(depvisor(?:@v\d+\.\d+\.\d+)?) -->$/m;

/** Render the state line, or nothing when a component fails its shape check. */
export function renderReportState(state: ReportState): string | null {
  if (
    !SHA.test(state.headSha) ||
    !CONCLUSION.test(state.conclusion) ||
    !GENERATOR.test(state.generator)
  ) {
    return null;
  }
  return `<!-- depvisor-v2-state sha:${state.headSha} ci:${state.conclusion} generator:${state.generator} -->`;
}

/** Parse the state line of a comment body; anything malformed parses as absent. */
export function parseReportState(body: string): ReportState | null {
  const match = STATE_LINE.exec(body);
  if (!match) return null;
  return { headSha: match[1]!, conclusion: match[2]!, generator: match[3]! };
}

/**
 * Name the generator with its released version. The version is read from
 * depvisor's own package.json (kept current by release-please) and validated
 * as a bare semver so an unexpected value never reaches the comment body.
 */
export function generatorName(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    );
    if (isRecord(pkg) && typeof pkg.version === "string" && /^\d+\.\d+\.\d+$/.test(pkg.version)) {
      return `depvisor@v${pkg.version}`;
    }
  } catch {
    // A report without a version beats a failed publication.
  }
  return "depvisor";
}
