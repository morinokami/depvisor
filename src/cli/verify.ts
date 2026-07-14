/** Entry point shared by isolated baseline, head, and candidate jobs. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AnalysisArtifactSchema,
  CandidateArtifactSchema,
  VerificationArtifactSchema,
  readArtifact,
  writeArtifact,
} from "../core/artifacts.ts";
import { applyPatch, changedPaths, createPatch, patchHash, resetHardClean } from "../core/git.ts";
import { checkCandidateScope, validatePatchEnvelope } from "../core/scope.ts";
import {
  publicVerificationResults,
  runCandidateVerification,
  runConfirmedVerification,
} from "../core/verify.ts";
import { setGitHubOutput } from "./github-output.ts";

const phase = process.env.DEPVISOR_VERIFY_PHASE;
if (phase !== "baseline" && phase !== "head" && phase !== "candidate") {
  throw new Error("DEPVISOR_VERIFY_PHASE must be baseline, head, or candidate");
}
const directory = process.env.DEPVISOR_ARTIFACT_DIR || "run";
mkdirSync(directory, { recursive: true });
const repo = process.env.DEPVISOR_TARGET_REPO || process.cwd();
const analysis = readArtifact(
  process.env.DEPVISOR_ANALYSIS_FILE || join(directory, "analysis.json"),
  AnalysisArtifactSchema,
);
const { config, target } = analysis.resolved;

let run;
let approvedPatchHash: string | null = null;
if (phase === "candidate") {
  const candidate = readArtifact(
    process.env.DEPVISOR_CANDIDATE_FILE || join(directory, "candidate.json"),
    CandidateArtifactSchema,
  );
  if (candidate.verdict !== "candidate") throw new Error("candidate verification needs a patch");
  if (
    !validatePatchEnvelope(candidate.patch).ok ||
    patchHash(candidate.patch) !== candidate.patchHash
  ) {
    throw new Error("candidate patch envelope/hash validation failed");
  }
  resetHardClean(repo, target.updaterHeadSha);
  applyPatch(repo, candidate.patch);
  const beforeScope = checkCandidateScope(repo, target.updaterHeadSha, analysis.protectedPaths);
  if (!beforeScope.ok || changedPaths(repo).length === 0) {
    run = {
      state: "dirty" as const,
      results: [],
      detail: `Candidate scope violation: ${beforeScope.violations.join(", ") || "empty patch"}`,
    };
  } else {
    run = runCandidateVerification(
      repo,
      target.updaterHeadSha,
      config.verification.prepare,
      config.verification.commands,
    );
    const afterScope = checkCandidateScope(repo, target.updaterHeadSha, analysis.protectedPaths);
    const afterPatch =
      run.state === "green" ? patchHash(createPatch(repo, target.updaterHeadSha)) : "";
    if (!afterScope.ok || (run.state === "green" && afterPatch !== candidate.patchHash)) {
      run = {
        state: "dirty" as const,
        results: run.results,
        detail: `Candidate seal failed: ${afterScope.violations.join(", ") || "patch hash changed"}`,
      };
    } else if (run.state === "green") {
      approvedPatchHash = candidate.patchHash;
    }
  }
} else {
  const sha = phase === "baseline" ? target.baseTipSha : target.prHeadSha;
  run = runConfirmedVerification(
    repo,
    sha,
    phase,
    config.verification.prepare,
    config.verification.commands,
  );
}

const output = join(
  directory,
  phase === "candidate" ? "candidate-verification.json" : `${phase}.json`,
);
writeArtifact(output, VerificationArtifactSchema, {
  schemaVersion: 2,
  phase,
  state: run.state,
  detail: run.detail,
  approvedPatchHash,
  results: publicVerificationResults(run.results),
  tails: run.results
    .filter((result) => !result.ok)
    .map((result) => ({ name: result.name, tail: result.tail })),
});
setGitHubOutput("state", run.state);
