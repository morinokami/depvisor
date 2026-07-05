import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPrWithGh } from "./core/github.ts";
import { PR_PAYLOADS_DIR, type PrPayload } from "./core/pr.ts";
import { RUN_STATUS_FILE, updateGroupStatus } from "./core/status.ts";
import { REPO } from "./shared/target.ts";

/**
 * Deterministic, token-holding entrypoint. Pushes each prepared branch and opens
 * or refreshes its PR from the payloads emitted by the update workflow. A single
 * failure does not stop the rest; the process exits non-zero if any PR failed.
 *
 *   node src/open-pr.ts [payloadFile]
 *
 * With no argument it enumerates pr-preview/payloads/*.json in processing order;
 * an explicit file processes just that one (dev convenience).
 */

function payloadFiles(explicit: string | undefined): string[] {
  if (explicit) return [explicit];
  const dir = fileURLToPath(new URL(`../pr-preview/${PR_PAYLOADS_DIR}`, import.meta.url));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

function main(): void {
  const args = process.argv.slice(2);
  const files = payloadFiles(args.find((a) => !a.startsWith("--")));
  const statusFile = fileURLToPath(new URL(`../pr-preview/${RUN_STATUS_FILE}`, import.meta.url));

  if (files.length === 0) {
    console.log(`No PR payloads under pr-preview/${PR_PAYLOADS_DIR} — nothing to open.`);
    return;
  }

  let anyFailed = false;
  for (const file of files) {
    const payload = JSON.parse(readFileSync(file, "utf8")) as PrPayload;
    console.log(`\nOpening PR for ${payload.branch} (from ${file})...`);
    // CI supplies a trusted push target; only trusted local dev falls back to the
    // target checkout's .git/config. Empty string = unset (composite action
    // forwards unset inputs as ""), so `|| undefined` lets github.ts fall back.
    const result = openPrWithGh(REPO, payload, process.env.DEPVISOR_REMOTE_URL || undefined);
    if (result.ok) {
      console.log(`  ${result.action}: ${result.url}`);
      updateGroupStatus(statusFile, payload.branch, { prUrl: result.url });
    } else if (result.action === "blocked") {
      // Policy stop, such as human commits on the branch: not a process failure.
      // Record it but stay green — an in-progress human takeover of the PR branch
      // is expected and must not turn recurring runs red.
      console.log(`  blocked: ${result.error}`);
      updateGroupStatus(statusFile, payload.branch, {
        status: "open-pr-blocked",
        summary: `PR creation was blocked: ${result.error}`,
      });
    } else {
      console.error(`  failed: ${result.error}`);
      updateGroupStatus(statusFile, payload.branch, {
        status: "open-pr-failed",
        summary: `PR creation failed: ${result.error}`,
      });
      anyFailed = true;
    }
  }

  if (anyFailed) process.exit(1);
}

main();
