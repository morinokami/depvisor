import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePrNumber, parseRefName } from "./core/config.ts";
import { publishAftercare, type PublishResult } from "./core/github.ts";
import { parseReportPayload, REPORT_PAYLOAD_FILE } from "./core/report.ts";
import { recordPublishOutcome, RUN_STATUS_FILE } from "./core/status.ts";
import { REPO } from "./shared/target.ts";

/**
 * Deterministic, token-holding entrypoint. Publishes the run's payload —
 * fast-forward-push of the repair commit (when one exists) plus the
 * marker-deduplicated report comment — onto the updater's PR.
 *
 *   node src/publish.ts [payloadFile]
 *
 * The PR identity comes from trusted env (DEPVISOR_PR_NUMBER /
 * DEPVISOR_HEAD_REF, set by action.yml from the Actions event context), never
 * from the payload, which is an untrusted read-back at this boundary. A
 * missing payload is a no-op (the workflow prepared nothing publishable); a
 * blocked publish stays green (expected churn); everything else exits 1.
 */

function errorMessage(err: unknown): string {
  return Error.isError(err) ? err.message : String(err);
}

function main(): void {
  const explicit = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const file =
    explicit ?? fileURLToPath(new URL(`../pr-preview/${REPORT_PAYLOAD_FILE}`, import.meta.url));
  const statusFile = fileURLToPath(new URL(`../pr-preview/${RUN_STATUS_FILE}`, import.meta.url));

  if (!existsSync(file)) {
    console.log(`No publish payload at ${file} — nothing to publish.`);
    return;
  }

  // Trusted PR identity from the workflow env — required at this boundary.
  const prNumber = parsePrNumber(process.env.DEPVISOR_PR_NUMBER || "");
  const headRef = parseRefName(process.env.DEPVISOR_HEAD_REF || "");
  if (prNumber === null || prNumber === "" || headRef === null || headRef === "") {
    console.error(
      "publish: DEPVISOR_PR_NUMBER and DEPVISOR_HEAD_REF must be set from the trusted " +
        "Actions event context; refusing to publish from payload data alone.",
    );
    recordPublishOutcome(statusFile, {
      status: "publish-failed",
      summary: "The publish step had no trusted PR identity (pr_number/head_ref unset or invalid).",
    });
    process.exit(1);
  }

  let result: PublishResult;
  try {
    const payload = parseReportPayload(JSON.parse(readFileSync(file, "utf8")));
    if (!payload) {
      throw new Error(
        "not a publish payload (headRef/expectedHeadSha/commentBody missing or mistyped)",
      );
    }
    console.log(
      `Publishing to PR #${prNumber} (${headRef}): ` +
        (payload.repairSha ? `repair ${payload.repairSha.slice(0, 8)} + report` : "report only"),
    );
    // CI supplies a trusted push target; only trusted local dev falls back to
    // the target checkout's .git/config. Empty string = unset (composite
    // actions forward unset inputs as ""), so `|| undefined` lets github.ts
    // fall back.
    result = publishAftercare(REPO, payload, {
      prNumber,
      headRef,
      remoteUrl: process.env.DEPVISOR_REMOTE_URL || undefined,
    });
  } catch (err) {
    const message = errorMessage(err);
    console.error(`  failed: ${message}`);
    recordPublishOutcome(statusFile, {
      status: "publish-failed",
      summary: `Publishing crashed: ${message}`,
    });
    process.exit(1);
  }

  if (result.ok) {
    console.log(
      `  published${result.pushed ? " (repair pushed)" : ""}: ${result.commentUrl ?? "(no comment URL returned)"}`,
    );
    // Keep the workflow's analysis status; record only the comment URL so the
    // step summary and outputs can link the report.
    recordPublishOutcome(statusFile, { commentUrl: result.commentUrl });
    return;
  }
  if (result.action === "blocked") {
    // Expected churn (PR closed/merged, or the updater rebased mid-run): not a
    // process failure. Record it but stay green — the next trigger re-runs on
    // the new head.
    console.log(`  blocked: ${result.error}`);
    recordPublishOutcome(statusFile, {
      status: "publish-blocked",
      summary: `Publishing was blocked: ${result.error}`,
    });
    return;
  }
  console.error(`  failed: ${result.error}`);
  recordPublishOutcome(statusFile, {
    status: "publish-failed",
    summary: `Publishing failed: ${result.error}`,
  });
  process.exit(1);
}

main();
