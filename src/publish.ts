import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePrNumber, parseRefName } from "./core/config.ts";
import { publishAftercare, type PublishResult } from "./core/github.ts";
import { parseReportPayload, REPAIR_BUNDLE_FILE, REPORT_PAYLOAD_FILE } from "./core/report.ts";

/**
 * Deterministic, token-holding entrypoint — the PUBLISH job's whole runtime.
 * It runs on a fresh runner that never executed target code (the job split is
 * the token-separation boundary: the analyze runner's files are taintable by
 * target scripts), consumes the analyze job's artifact (payload + repair
 * bundle — both untrusted data here), and publishes: a compare-and-swap
 * fast-forward push of the re-verified repair range, plus the
 * marker-deduplicated report comment.
 *
 *   node src/publish.ts
 *
 * Env: DEPVISOR_PAYLOAD_DIR (the downloaded artifact directory; local dev
 * points it at pr-preview/), DEPVISOR_PR_NUMBER / DEPVISOR_HEAD_REF (trusted
 * PR identity from the Actions event context — never the payload), and
 * DEPVISOR_REMOTE_URL (the trusted push target). A missing payload is a
 * benign no-op; a blocked publish stays green; everything else exits 1.
 *
 * Outputs go straight to $GITHUB_OUTPUT (status / pushed / comment_url),
 * machine-shaped only, so the publish action can expose them.
 */

// Same charset stance as status.ts's action outputs: outputs feed consumer
// `${{ }}` interpolation. `#` allowed for GitHub's #issuecomment anchors.
const OUTPUT_URL_RE = /^https:\/\/[A-Za-z0-9./_#-]+$/;

function writeOutputs(outputs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(outputs).flatMap(([name, value]) => {
    const delimiter = `DEPVISOR_OUTPUT_${randomUUID()}`;
    return [`${name}<<${delimiter}`, value, delimiter];
  });
  appendFileSync(file, `${lines.join("\n")}\n`);
}

function finish(status: string, pushed: boolean, commentUrl: string | null, exitCode = 0): never {
  writeOutputs({
    status,
    pushed: pushed ? "true" : "false",
    comment_url: commentUrl && OUTPUT_URL_RE.test(commentUrl) ? commentUrl : "",
  });
  process.exit(exitCode);
}

function errorMessage(err: unknown): string {
  return Error.isError(err) ? err.message : String(err);
}

function main(): void {
  const payloadDir = resolve(process.env.DEPVISOR_PAYLOAD_DIR || "pr-preview");
  const payloadFile = join(payloadDir, REPORT_PAYLOAD_FILE);
  const bundleFile = join(payloadDir, REPAIR_BUNDLE_FILE);

  if (!existsSync(payloadFile)) {
    console.log(`No publish payload at ${payloadFile} — nothing to publish.`);
    finish("no-payload", false, null);
  }

  // Trusted PR identity and push target from the workflow env — required at
  // this boundary; the payload is an untrusted read-back that must merely
  // agree.
  const prNumber = parsePrNumber(process.env.DEPVISOR_PR_NUMBER || "");
  const headRef = parseRefName(process.env.DEPVISOR_HEAD_REF || "");
  const remoteUrl = (process.env.DEPVISOR_REMOTE_URL || "").trim();
  if (prNumber === null || prNumber === "" || headRef === null || headRef === "" || !remoteUrl) {
    console.error(
      "::error::publish needs DEPVISOR_PR_NUMBER, DEPVISOR_HEAD_REF, and DEPVISOR_REMOTE_URL " +
        "from the trusted Actions event context; refusing to publish from payload data alone.",
    );
    finish("publish-failed", false, null, 1);
  }

  let result: PublishResult;
  try {
    const payload = parseReportPayload(JSON.parse(readFileSync(payloadFile, "utf8")));
    if (!payload) {
      throw new Error(
        "not a publish payload (headRef/expectedHeadSha/commentBody missing or mistyped)",
      );
    }
    console.log(
      `Publishing to PR #${prNumber} (${headRef}): ` +
        (payload.repairSha ? `repair ${payload.repairSha.slice(0, 8)} + report` : "report only"),
    );
    result = publishAftercare(
      payload,
      { prNumber, headRef, remoteUrl },
      existsSync(bundleFile) ? bundleFile : null,
    );
  } catch (err) {
    const message = errorMessage(err);
    console.error(`::error::publishing crashed: ${message}`);
    finish("publish-failed", false, null, 1);
  }

  if (result.ok) {
    console.log(
      `  published${result.pushed ? " (repair pushed)" : ""}: ${result.commentUrl ?? "(no comment URL returned)"}`,
    );
    finish("published", result.pushed, result.commentUrl);
  }
  if (result.action === "blocked") {
    // Expected churn (PR closed/merged, or the updater rebased mid-run): not a
    // process failure. Stay green — the next PR event re-runs on the new head.
    console.log(`  blocked: ${result.error}`);
    finish("publish-blocked", false, null);
  }
  console.error(`::error::publishing failed: ${result.error}`);
  finish("publish-failed", result.pushed, result.commentUrl, 1);
}

main();
