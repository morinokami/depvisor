/** Serialize the fixer's bounded working-tree changes into a content-addressed patch. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AgentArtifactSchema,
  AnalysisArtifactSchema,
  CandidateArtifactSchema,
  FixerReportSchema,
  readArtifact,
  writeArtifact,
} from "../core/artifacts.ts";
import { changedPaths, createPatch, patchHash } from "../core/git.ts";
import { checkCandidateScope, validatePatchEnvelope } from "../core/scope.ts";
import { setGitHubOutput } from "./github-output.ts";
import * as v from "valibot";

const directory = process.env.DEPVISOR_ARTIFACT_DIR || "run";
mkdirSync(directory, { recursive: true });
const repo = process.env.DEPVISOR_TARGET_REPO || process.cwd();
const analysis = readArtifact(
  process.env.DEPVISOR_ANALYSIS_FILE || join(directory, "analysis.json"),
  AnalysisArtifactSchema,
);
const agent = readArtifact(
  process.env.DEPVISOR_AGENT_FILE || join(directory, "fixer.json"),
  AgentArtifactSchema,
);
if (agent.role !== "fixer") throw new Error("candidate serializer requires a fixer artifact");
const report = v.parse(FixerReportSchema, agent.report);

let verdict: "candidate" | "deferred" | "scope-violation";
let detail: string;
let patch = "";
let hash = "";
const paths = changedPaths(repo);
if (report.verdict === "defer") {
  verdict = "deferred";
  detail = report.defer_reason || report.summary;
} else {
  const scope = checkCandidateScope(
    repo,
    analysis.resolved.target.updaterHeadSha,
    analysis.protectedPaths,
  );
  patch = createPatch(repo, analysis.resolved.target.updaterHeadSha);
  const envelope = validatePatchEnvelope(patch);
  if (!scope.ok || !envelope.ok) {
    verdict = "scope-violation";
    detail = [...scope.violations, ...envelope.violations].join(", ");
  } else {
    verdict = "candidate";
    detail = report.summary;
    hash = patchHash(patch);
  }
}

writeArtifact(join(directory, "candidate.json"), CandidateArtifactSchema, {
  schemaVersion: 2,
  verdict,
  detail,
  patch,
  patchHash: hash,
  paths,
});
setGitHubOutput("verdict", verdict);
setGitHubOutput("patch_hash", hash);
