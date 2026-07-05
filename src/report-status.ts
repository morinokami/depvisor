import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appendStepSummary,
  readRunStatus,
  RUN_STATUS_FILE,
  statusAnnotationLevel,
  statusFailsJob,
  statusLogLine,
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

  const message = `depvisor ${statusLogLine(status)}`;
  emitAnnotation(statusAnnotationLevel(status.status), message);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendStepSummary(summaryFile, status);

  if (statusFailsJob(status.status)) process.exit(1);
}

main();
