import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openPrWithGh } from "./core/github.ts";
import { PR_PAYLOAD_FILE, type PrPayload } from "./core/pr.ts";
import { RUN_STATUS_FILE, updateRunStatus } from "./core/status.ts";
import { REPO } from "./shared/target.ts";

/**
 * Deterministic, token-holding entrypoint. Pushes the branch and opens or
 * refreshes the PR from the payload emitted by the update workflow.
 *
 *   node src/open-pr.ts [payloadFile]
 */

function main(): void {
  const args = process.argv.slice(2);
  const file =
    args.find((a) => !a.startsWith("--")) ??
    fileURLToPath(new URL(`../pr-preview/${PR_PAYLOAD_FILE}`, import.meta.url));
  const statusFile = fileURLToPath(new URL(`../pr-preview/${RUN_STATUS_FILE}`, import.meta.url));

  if (!existsSync(file)) {
    console.log(`No PR payload at ${file} — nothing to open.`);
    return;
  }
  const payload = JSON.parse(readFileSync(file, "utf8")) as PrPayload;
  console.log(`\nOpening PR for ${payload.branch} (from ${file})...`);
  // CI supplies a trusted push target; only trusted local dev falls back to the
  // target checkout's .git/config.
  // Empty string = unset (composite action forwards unset inputs as ""), so
  // `|| undefined` lets github.ts fall back to config on a trusted local dev box.
  const result = openPrWithGh(REPO, payload, process.env.DEPVISOR_REMOTE_URL || undefined);
  if (result.ok) {
    console.log(`  ${result.action}: ${result.url}`);
    updateRunStatus(statusFile, { prUrl: result.url });
  } else if (result.action === "blocked") {
    // Policy stop, such as human commits on the branch: not a process failure.
    // Record it but stay green — an in-progress human takeover of the PR branch
    // is expected and must not turn recurring runs red.
    console.log(`  blocked: ${result.error}`);
    updateRunStatus(statusFile, {
      status: "open-pr-blocked",
      summary: `PR creation was blocked: ${result.error}`,
    });
  } else {
    console.error(`  failed: ${result.error}`);
    updateRunStatus(statusFile, {
      status: "open-pr-failed",
      summary: `PR creation failed: ${result.error}`,
    });
    process.exit(1);
  }
}

main();
