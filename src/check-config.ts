/**
 * Action-level config validation before the target install. The workflow runs
 * parseRunConfig again for defense in depth and to own normal status emission;
 * this entrypoint exists only to reject typos before waiting for target setup.
 */

import { fileURLToPath } from "node:url";
import { parseRunConfig } from "./core/config.ts";
import { clearPrPreview } from "./core/report.ts";
import { emitRunStatus, emptyRunStatus } from "./core/status.ts";

const OUT_DIR = fileURLToPath(new URL("../pr-preview", import.meta.url));

// Clear before parsing too: a later setup/model failure must not let the final
// always() reporter mistake a previous local invocation's status for this run.
clearPrPreview(OUT_DIR);
const parsed = parseRunConfig(process.env);
if (!parsed.ok) {
  emitRunStatus(OUT_DIR, emptyRunStatus(parsed.status, parsed.summary));
  console.error(`depvisor config invalid: ${parsed.status}`);
  process.exit(1);
}
