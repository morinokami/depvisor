import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appendStepSummary,
  groupLogLine,
  readRunStatus,
  runFailsJob,
  runLogLine,
  RUN_STATUS_FILE,
  statusFailsJob,
} from "./core/status.ts";

const DEFAULT_STATUS_FILE = fileURLToPath(
  new URL(`../pr-preview/${RUN_STATUS_FILE}`, import.meta.url),
);

function workflowEscape(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function emitAnnotation(level: "notice" | "error", message: string): void {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${level}::${workflowEscape(message)}`);
  } else {
    console.log(`${level}: ${message}`);
  }
}

function appendMissingSummary(message: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `## depvisor\n\n${message}\n`);
}

function main(): void {
  const file = process.argv.find((arg, i) => i > 1 && !arg.startsWith("--")) ?? DEFAULT_STATUS_FILE;
  const status = readRunStatus(file);
  if (!status) {
    const message =
      `depvisor did not emit ${RUN_STATUS_FILE}; a setup or agent step likely failed ` +
      "before reporting a result.";
    emitAnnotation("error", message);
    appendMissingSummary(message);
    process.exit(1);
  }

  // Run-level annotation reflects the overall job outcome (a completed run with
  // a failed group is still a red job), then one error annotation per failing
  // group so each no-PR/failed outcome is surfaced individually.
  const runFails = runFailsJob(status);
  emitAnnotation(runFails ? "error" : "notice", `depvisor ${runLogLine(status)}`);
  for (const group of status.groups) {
    if (statusFailsJob(group.status)) {
      emitAnnotation("error", `depvisor ${groupLogLine(group)}`);
    }
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendStepSummary(summaryFile, status);

  if (runFails) process.exit(1);
}

main();
