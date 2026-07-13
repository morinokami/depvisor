import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dryRunPlanPath,
  readDryRunPlan,
  renderDryRunPlan,
  type DryRunPlan,
} from "./core/dry-run.ts";
import {
  appendStepSummary,
  groupLogLine,
  readRunStatus,
  runFailsJob,
  runLogLine,
  RUN_STATUS_FILE,
  statusFailsJob,
  toActionOutputs,
} from "./core/status.ts";

const DEFAULT_STATUS_FILE = fileURLToPath(
  new URL(`../pr-preview/${RUN_STATUS_FILE}`, import.meta.url),
);

function workflowEscape(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
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

/**
 * Write the action outputs the composite `outputs:` mapping picks up. Values
 * are charset-gated in toActionOutputs; the uniform heredoc form with a random
 * delimiter is the standard defense against delimiter-collision injection, and
 * keeps holding if a future output ever carries freer text. Must run before
 * any exit(1) — outputs a failed step wrote still reach the mapping.
 */
function writeActionOutputs(outputs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(outputs).flatMap(([name, value]) => {
    const delimiter = `DEPVISOR_OUTPUT_${randomUUID()}`;
    return [`${name}<<${delimiter}`, value, delimiter];
  });
  appendFileSync(file, `${lines.join("\n")}\n`);
}

function main(): void {
  const file = process.argv.find((arg, i) => i > 1 && !arg.startsWith("--")) ?? DEFAULT_STATUS_FILE;
  const status = readRunStatus(file);
  if (!status) {
    // The crash-before-reporting case is when consumers most need a signal, so
    // outputs (failed=true) are written even on this path, before the exit.
    // Missing and corrupt read the same (readRunStatus fails both toward
    // null); only the message distinguishes them.
    writeActionOutputs(toActionOutputs(null));
    const message = existsSync(file)
      ? `depvisor wrote an unreadable ${RUN_STATUS_FILE} (corrupt or truncated); ` +
        "treating the run as failed."
      : `depvisor did not emit ${RUN_STATUS_FILE}; a setup or agent step likely failed ` +
        "before reporting a result.";
    emitAnnotation("error", message);
    appendMissingSummary(message);
    process.exit(1);
  }
  let dryRunPlan: DryRunPlan | null = null;
  if (status.status === "dry-run-completed") {
    const planFile = dryRunPlanPath(dirname(file));
    dryRunPlan = readDryRunPlan(planFile);
    if (!dryRunPlan) {
      writeActionOutputs(toActionOutputs(null));
      const message = existsSync(planFile)
        ? "depvisor wrote an unreadable dry-run plan (corrupt or truncated); treating the run as failed."
        : "depvisor reported dry-run-completed without emitting its plan; treating the run as failed.";
      emitAnnotation("error", message);
      appendMissingSummary(message);
      process.exit(1);
    }
  }
  writeActionOutputs(toActionOutputs(status));

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
  if (summaryFile) {
    appendStepSummary(summaryFile, status);
    if (dryRunPlan) appendFileSync(summaryFile, `${renderDryRunPlan(dryRunPlan)}\n`);
  }

  if (runFails) process.exit(1);
}

main();
