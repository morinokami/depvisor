import type { AnalysisArtifact, CandidateArtifact, VerificationArtifact } from "./artifacts.ts";
import type { V2Status } from "./types.ts";

export interface FinalDecision {
  status: V2Status;
  pushCandidate: boolean;
}

export function classifyResult(
  analysis: AnalysisArtifact,
  baseline: VerificationArtifact | null,
  head: VerificationArtifact | null,
  candidate: CandidateArtifact | null,
  candidateVerification: VerificationArtifact | null,
): FinalDecision {
  if (analysis.provisionalStatus !== null) {
    return { status: analysis.provisionalStatus, pushCandidate: false };
  }
  if (!analysis.verificationSelected || !baseline || !head) {
    return { status: "publish-failed", pushCandidate: false };
  }
  if (baseline.state === "unexpected-commits") {
    return { status: "unexpected-commits", pushCandidate: false };
  }
  if (baseline.state === "unstable") {
    return { status: "verification-unstable", pushCandidate: false };
  }
  if (baseline.state !== "green") {
    return { status: "baseline-red", pushCandidate: false };
  }
  if (head.state === "unexpected-commits" || head.state === "dirty") {
    return { status: "unexpected-commits", pushCandidate: false };
  }
  if (head.state === "unstable") {
    return { status: "verification-unstable", pushCandidate: false };
  }
  if (head.state === "green") {
    return { status: "failure-not-reproduced", pushCandidate: false };
  }
  if (!candidate) return { status: "publish-failed", pushCandidate: false };
  if (candidate.verdict === "deferred") {
    return { status: "repair-deferred", pushCandidate: false };
  }
  if (candidate.verdict === "scope-violation") {
    return { status: "scope-violation", pushCandidate: false };
  }
  if (!candidateVerification) return { status: "publish-failed", pushCandidate: false };
  if (candidateVerification.state === "unexpected-commits") {
    return { status: "unexpected-commits", pushCandidate: false };
  }
  if (candidateVerification.state === "dirty") {
    return { status: "scope-violation", pushCandidate: false };
  }
  if (candidateVerification.state !== "green") {
    return { status: "verification-failed", pushCandidate: false };
  }
  if (candidateVerification.approvedPatchHash !== candidate.patchHash) {
    return { status: "publish-failed", pushCandidate: false };
  }
  return { status: "repair-applied", pushCandidate: true };
}
