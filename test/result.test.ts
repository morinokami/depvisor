import assert from "node:assert/strict";
import test from "node:test";
import { classifyResult } from "../src/core/result.ts";
import type {
  AnalysisArtifact,
  CandidateArtifact,
  VerificationArtifact,
} from "../src/core/artifacts.ts";

function verification(
  phase: VerificationArtifact["phase"],
  state: VerificationArtifact["state"],
): VerificationArtifact {
  return {
    schemaVersion: 2,
    phase,
    state,
    detail: state,
    approvedPatchHash: phase === "candidate" && state === "green" ? candidate.patchHash : null,
    results: [],
    tails: [],
  };
}

const analysis = {
  schemaVersion: 2,
  verificationSelected: true,
  provisionalStatus: null,
} as AnalysisArtifact;

const candidate: CandidateArtifact = {
  schemaVersion: 2,
  verdict: "candidate",
  detail: "ok",
  patch: "diff --git a/a.ts b/a.ts\n",
  patchHash: "a".repeat(64),
  paths: ["a.ts"],
};

test("fixer runs only for stable attributable head failures", () => {
  assert.deepEqual(
    classifyResult(
      analysis,
      verification("baseline", "green"),
      verification("head", "green"),
      null,
      null,
    ),
    { status: "failure-not-reproduced", pushCandidate: false },
  );
  assert.equal(
    classifyResult(
      analysis,
      verification("baseline", "unstable"),
      verification("head", "stable-red"),
      candidate,
      verification("candidate", "green"),
    ).status,
    "verification-unstable",
  );
});

test("only a green isolated candidate reaches the publisher", () => {
  assert.deepEqual(
    classifyResult(
      analysis,
      verification("baseline", "green"),
      verification("head", "stable-red"),
      candidate,
      verification("candidate", "green"),
    ),
    { status: "repair-applied", pushCandidate: true },
  );
  assert.equal(
    classifyResult(
      analysis,
      verification("baseline", "green"),
      verification("head", "stable-red"),
      candidate,
      verification("candidate", "stable-red"),
    ).status,
    "verification-failed",
  );
});
