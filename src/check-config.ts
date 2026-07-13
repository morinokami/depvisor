/**
 * Action-level config validation before the target install. The workflow runs
 * parseRunConfig again for defense in depth and to own normal status emission;
 * this entrypoint exists only to reject typos before waiting for target setup.
 */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRunConfig } from "./core/config.ts";
import { clearPrPreview } from "./core/pr.ts";
import { emitRunStatus } from "./core/status.ts";

const OUT_DIR = fileURLToPath(new URL("../pr-preview", import.meta.url));

// Clear before parsing too: a later setup/model failure must not let the final
// always() reporter mistake a previous local invocation's status/plan for this run.
clearPrPreview(OUT_DIR);
const parsed = parseRunConfig(process.env);
if (!parsed.ok) {
  emitRunStatus(OUT_DIR, {
    status: parsed.status,
    base: null,
    summary: parsed.summary,
    groups: [],
  });
  console.error(`depvisor config invalid: ${parsed.status}`);
  process.exit(1);
}

const output = process.env.GITHUB_OUTPUT;
if (output) appendFileSync(output, `dry_run=${parsed.config.dryRun}\n`);
