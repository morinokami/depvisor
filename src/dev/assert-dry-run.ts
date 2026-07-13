/**
 * CI assertion for the credential-free Flue dry-run E2E. The workflow itself
 * produces the plan/status; this plain-node checker verifies the two read-back
 * contracts plus the no-target-mutation/no-payload promises without copying
 * any candidate-selection logic.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dryRunPlanPath, readDryRunPlan } from "../core/dry-run.ts";
import { isClean, snapshotRefs } from "../core/git.ts";
import { PR_PAYLOADS_DIR } from "../core/pr.ts";
import { readRunStatus, runFailsJob, statusPath, toActionOutputs } from "../core/status.ts";

const repoArg = process.argv[2];
const expectedArg = process.argv[3];
assert.ok(
  repoArg && expectedArg,
  "usage: node src/dev/assert-dry-run.ts <target-repo> <expected-package[@location],...>",
);
const repo = resolve(repoArg);
const outDir = fileURLToPath(new URL("../../pr-preview", import.meta.url));

const status = readRunStatus(statusPath(outDir));
assert.ok(status, "dry-run status.json must be readable");
assert.equal(status.status, "dry-run-completed");
assert.equal(runFailsJob(status), false, "the green fixture dry run must have no red findings");

const outputs = toActionOutputs(status);
assert.equal(outputs.prepared_count, "0");
assert.equal(outputs.pr_urls, "");
assert.equal(outputs.total_tokens, "0");
assert.equal(outputs.est_cost_usd, "0.000000");

const plan = readDryRunPlan(dryRunPlanPath(outDir));
assert.ok(plan, "dry-run-plan.json must be readable and schema-valid");
assert.ok(plan.collected.length > 0, "fixture dry run must collect candidates");
assert.ok(plan.groups.length > 0, "fixture dry run must plan groups");
const expectedEntries = expectedArg
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const collectedNames = plan.collected.map((candidate) => candidate.name);
for (const entry of expectedEntries) {
  assert.ok(
    collectedNames.some((name) => entry === name || entry.startsWith(`${name}@`)),
    `dry-run plan did not collect expected fixture entry ${entry}`,
  );
}
for (const name of collectedNames) {
  assert.ok(
    expectedEntries.some((entry) => entry === name || entry.startsWith(`${name}@`)),
    `dry-run plan collected unexpected fixture package ${name}`,
  );
}
assert.deepEqual(
  [...new Set(plan.groups.flatMap((group) => group.packages.map((pkg) => pkg.name)))].toSorted(),
  [...new Set(collectedNames)].toSorted(),
  "default fixture grouping must cover every collected package exactly by name",
);

assert.equal(existsSync(join(outDir, PR_PAYLOADS_DIR)), false, "dry run must emit no PR payloads");
assert.equal(isClean(repo), true, "dry run must leave the fixture worktree clean");
assert.equal(
  [...snapshotRefs(repo).keys()].some((ref) => ref.startsWith("refs/heads/depvisor/")),
  false,
  "dry run must create no depvisor branch",
);

console.log(
  `dry-run E2E ok: ${plan.collected.length} candidate(s), ${plan.groups.length} group(s), no model usage or target changes`,
);
