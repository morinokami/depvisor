/** Normalize one immutable updater diff and evaluate trusted cost/repair policy. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AnalysisArtifactSchema,
  ResolveArtifactSchema,
  readArtifact,
  writeArtifact,
} from "../core/artifacts.ts";
import { mergeBase, revParse } from "../core/git.ts";
import { collectEvidence } from "../core/evidence.ts";
import { decidePolicy } from "../core/policy.ts";
import type { V2Status } from "../core/types.ts";
import { normalizeUpdate } from "../ecosystems/index.ts";
import { setGitHubOutput } from "./github-output.ts";

function paths(): { resolve: string; analysis: string; repo: string } {
  const directory = process.env.DEPVISOR_ARTIFACT_DIR || "run";
  mkdirSync(directory, { recursive: true });
  return {
    resolve: process.env.DEPVISOR_RESOLVE_FILE || join(directory, "resolve.json"),
    analysis: join(directory, "analysis.json"),
    repo: process.env.DEPVISOR_TARGET_REPO || process.cwd(),
  };
}

const files = paths();
const resolve = readArtifact(files.resolve, ResolveArtifactSchema);
if (!resolve.resolved) throw new Error("normalize requires an admitted resolve artifact");
const { resolved } = resolve;
const { target, config } = resolved;

if (revParse(files.repo, target.prHeadSha) !== target.prHeadSha) {
  throw new Error("the checkout does not contain the immutable PR head");
}
const computedMergeBase = mergeBase(files.repo, target.baseTipSha, target.updaterHeadSha);
if (computedMergeBase !== target.mergeBaseSha) {
  throw new Error("the local merge base disagrees with the trusted resolver snapshot");
}

const normalized = normalizeUpdate(files.repo, target.mergeBaseSha, target.updaterHeadSha);
const policy = decidePolicy(config, normalized.changes);
const changes =
  policy.review || policy.repair ? await collectEvidence(normalized.changes) : normalized.changes;
const triggerGreen = resolved.triggerConclusion === "success";
let provisionalStatus: V2Status | null = null;
let verificationSelected = false;

if (!policy.review && !policy.repair) {
  provisionalStatus = "policy-skipped";
} else if (!policy.repair) {
  provisionalStatus = "reviewed";
} else if (resolved.existingRepair) {
  provisionalStatus = triggerGreen
    ? "repair-applied"
    : resolved.refresh.kind === "manual"
      ? "updater-refresh-required"
      : "updater-refresh-requested";
} else if (triggerGreen) {
  provisionalStatus = "repair-not-needed";
} else if (config.verification.commands.length === 0) {
  provisionalStatus = "verification-unavailable";
} else if (!normalized.repairSafe) {
  provisionalStatus = "repair-unsupported";
} else if (target.mergeBaseSha !== target.baseTipSha) {
  provisionalStatus =
    resolved.refresh.kind === "manual" ? "updater-refresh-required" : "updater-refresh-requested";
} else if (!resolved.inRepository) {
  provisionalStatus = "repair-unsupported";
} else {
  verificationSelected = true;
}

writeArtifact(files.analysis, AnalysisArtifactSchema, {
  schemaVersion: 2,
  resolved,
  changes,
  changedPaths: normalized.changedPaths,
  protectedPaths: normalized.protectedPaths,
  repairSafe: normalized.repairSafe,
  genericReasons: normalized.genericReasons,
  policy,
  reviewSelected: policy.review,
  verificationSelected,
  provisionalStatus,
});

setGitHubOutput("review_selected", policy.review);
setGitHubOutput("repair_selected", policy.repair);
setGitHubOutput("verification_selected", verificationSelected);
setGitHubOutput("provisional_status", provisionalStatus ?? "in-progress");
