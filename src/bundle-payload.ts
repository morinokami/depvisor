import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepairBundle, revParse } from "./core/git.ts";
import { parseReportPayload, REPAIR_BUNDLE_FILE, REPORT_PAYLOAD_FILE } from "./core/report.ts";
import { REPO } from "./shared/target.ts";

/**
 * Tokenless entrypoint, run in the ANALYZE job right after the agent step:
 * package the repair commit (when one exists) into a git bundle next to the
 * payload, so the artifact can carry it to the publish job's fresh runner.
 * The two jobs never share a machine — that separation is what keeps runner
 * files a target script tainted (`$GITHUB_PATH`, `$GITHUB_ENV`, `BASH_ENV`)
 * away from the GH_TOKEN — so commits must travel as data, not as a checkout.
 *
 * The bundle is untrusted input at the publish boundary (this process runs on
 * the same tainted runner as the target's scripts); the publish job
 * re-verifies the range structurally before pushing. This step only fails
 * closed on the one inconsistency it can see: a head branch whose tip is no
 * longer the payload's repair commit.
 */

function main(): void {
  const outDir = fileURLToPath(new URL("../pr-preview", import.meta.url));
  const payloadFile = join(outDir, REPORT_PAYLOAD_FILE);
  if (!existsSync(payloadFile)) {
    console.log("No publish payload — nothing to bundle.");
    return;
  }
  let payload;
  try {
    payload = parseReportPayload(JSON.parse(readFileSync(payloadFile, "utf8")));
  } catch {
    payload = null;
  }
  if (!payload) {
    console.error("::error::the publish payload is unreadable; nothing was bundled.");
    process.exit(1);
  }
  if (payload.repairSha === null) {
    console.log("Report-only payload — no repair commit to bundle.");
    return;
  }
  const tip = revParse(REPO, `refs/heads/${payload.headRef}`);
  if (tip !== payload.repairSha) {
    console.error(
      `::error::the head branch tip (${tip.slice(0, 8)}) is not the payload's repair commit ` +
        `(${payload.repairSha.slice(0, 8)}); refusing to bundle.`,
    );
    process.exit(1);
  }
  const bundle = join(outDir, REPAIR_BUNDLE_FILE);
  createRepairBundle(REPO, bundle, payload.expectedHeadSha, payload.headRef);
  console.log(`Repair bundle written: ${bundle}`);
}

main();
