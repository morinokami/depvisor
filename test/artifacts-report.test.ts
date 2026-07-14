import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as v from "valibot";
import {
  AgentArtifactSchema,
  CandidateArtifactSchema,
  VerificationArtifactSchema,
  readArtifact,
  writeArtifact,
  type AnalysisArtifact,
} from "../src/core/artifacts.ts";
import { renderReport } from "../src/core/report.ts";

test("cross-job artifacts reject unknown fields and invalid hashes", () => {
  assert.throws(
    () =>
      v.parse(CandidateArtifactSchema, {
        schemaVersion: 2,
        verdict: "candidate",
        detail: "ok",
        patch: "diff --git a/a.ts b/a.ts\n",
        patchHash: "not-a-hash",
        paths: ["a.ts"],
      }),
    /Invalid format/,
  );
  assert.throws(
    () =>
      v.parse(CandidateArtifactSchema, {
        schemaVersion: 2,
        verdict: "deferred",
        detail: "no",
        patch: "",
        patchHash: "",
        paths: [],
        smuggled: true,
      }),
    /Invalid key/i,
  );
  assert.throws(() =>
    v.parse(VerificationArtifactSchema, {
      schemaVersion: 2,
      phase: "head",
      state: "green",
      detail: "forged",
      approvedPatchHash: "a".repeat(64),
      results: [],
      tails: [],
    }),
  );
  assert.throws(() =>
    v.parse(AgentArtifactSchema, {
      schemaVersion: 2,
      role: "reviewer",
      report: {
        summary: "wrong role",
        fixes_applied: [],
        residual_risks: [],
        verdict: "fixed",
      },
      usage: {
        role: "reviewer",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        costUsd: 0,
        model: "test/model",
      },
    }),
  );
});

test("artifact IO is round-tripped through its schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "depvisor-artifact-test-"));
  const path = join(directory, "candidate.json");
  try {
    const candidate = {
      schemaVersion: 2 as const,
      verdict: "candidate" as const,
      detail: "ok",
      patch: "diff --git a/a.ts b/a.ts\n",
      patchHash: "a".repeat(64),
      paths: ["test/a.test.ts"],
    };
    writeArtifact(path, CandidateArtifactSchema, candidate);
    assert.deepEqual(readArtifact(path, CandidateArtifactSchema), candidate);
    assert.match(readFileSync(path, "utf8"), /"schemaVersion": 2/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the deterministic report sanitizes narrative text and surfaces test edits", () => {
  const analysis = {
    changes: [
      {
        ecosystem: "javascript",
        manager: "npm",
        package: "example",
        from: "1.0.0",
        to: "2.0.0",
        capability: "repair-safe",
        evidence: [],
      },
    ],
    resolved: { target: { updaterHeadSha: "a".repeat(40) } },
  } as unknown as AnalysisArtifact;
  const report = renderReport(
    "repair-applied",
    analysis,
    {
      summary: "safe <!-- hidden --> summary",
      upstream_changes: [],
      observed_usage: [],
      confirmed_risks: [],
      inferred_risks: [],
      reviewer_checks: [],
      evidence: [],
    },
    null,
    [],
    "b".repeat(40),
    ["test/cache.test.ts", "src/cache.ts"],
  );
  assert.doesNotMatch(report, /hidden/);
  assert.match(report, /Test changes/);
  assert.match(report, /test\/cache\.test\.ts/);
});
