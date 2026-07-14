/** Typed, bounded JSON contracts crossing isolated GitHub Actions jobs. */

import { readFileSync, writeFileSync } from "node:fs";
import * as v from "valibot";
import { DepvisorConfigSchema } from "./config.ts";
import {
  DependencyChangeSchema,
  PullRequestTargetSchema,
  UsageEntrySchema,
  V2StatusSchema,
  VerificationStepResultSchema,
} from "./types.ts";

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

const RefreshInstructionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("comment"), value: v.string() }),
  v.strictObject({ kind: v.literal("label"), value: v.string() }),
  v.strictObject({ kind: v.literal("manual"), value: v.string() }),
]);

export const ResolvedPullRequestSchema = v.strictObject({
  target: PullRequestTargetSchema,
  config: DepvisorConfigSchema,
  configDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  triggerConclusion: v.nullable(v.string()),
  existingRepair: v.boolean(),
  inRepository: v.boolean(),
  refresh: RefreshInstructionSchema,
});

export const ResolveArtifactSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(2),
    terminalStatus: v.nullable(V2StatusSchema),
    summary: v.string(),
    resolved: v.nullable(ResolvedPullRequestSchema),
  }),
  v.check(
    (artifact) => (artifact.terminalStatus === null) === (artifact.resolved !== null),
    "resolve artifact must be either admitted or terminal",
  ),
);
export type ResolveArtifact = v.InferOutput<typeof ResolveArtifactSchema>;

export const AnalysisArtifactSchema = v.strictObject({
  schemaVersion: v.literal(2),
  resolved: ResolvedPullRequestSchema,
  changes: v.array(DependencyChangeSchema),
  changedPaths: v.array(v.string()),
  protectedPaths: v.array(v.string()),
  repairSafe: v.boolean(),
  genericReasons: v.array(v.string()),
  policy: v.strictObject({
    review: v.boolean(),
    repair: v.boolean(),
    overDependencyLimit: v.boolean(),
    llmCalls: v.number(),
  }),
  reviewSelected: v.boolean(),
  verificationSelected: v.boolean(),
  provisionalStatus: v.nullable(V2StatusSchema),
});
export type AnalysisArtifact = v.InferOutput<typeof AnalysisArtifactSchema>;

export const VerificationArtifactSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(2),
    phase: v.picklist(["baseline", "head", "candidate"]),
    state: v.picklist(["green", "stable-red", "unstable", "unexpected-commits", "dirty"]),
    detail: v.string(),
    approvedPatchHash: v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
    results: v.array(VerificationStepResultSchema),
    tails: v.array(v.strictObject({ name: v.string(), tail: v.string() })),
  }),
  v.check(
    (artifact) =>
      artifact.results.every((result) => result.phase === artifact.phase) &&
      (artifact.approvedPatchHash === null ||
        (artifact.phase === "candidate" && artifact.state === "green")),
    "verification artifact phase/hash relationship is invalid",
  ),
);
export type VerificationArtifact = v.InferOutput<typeof VerificationArtifactSchema>;

export const ReviewerReportSchema = v.strictObject({
  summary: v.string(),
  upstream_changes: v.array(v.strictObject({ package: v.string(), note: v.string() })),
  observed_usage: v.array(
    v.strictObject({ path: v.string(), symbol: v.string(), note: v.string() }),
  ),
  confirmed_risks: v.array(v.string()),
  inferred_risks: v.array(v.string()),
  reviewer_checks: v.array(v.string()),
  evidence: v.array(v.string()),
});
export type ReviewerReport = v.InferOutput<typeof ReviewerReportSchema>;

export const FixerReportSchema = v.strictObject({
  summary: v.string(),
  fixes_applied: v.array(v.string()),
  residual_risks: v.array(v.string()),
  verdict: v.picklist(["fixed", "defer"]),
  defer_reason: v.optional(v.string()),
});
export type FixerReport = v.InferOutput<typeof FixerReportSchema>;

export const AgentArtifactSchema = v.variant("role", [
  v.strictObject({
    schemaVersion: v.literal(2),
    role: v.literal("fixer"),
    report: FixerReportSchema,
    usage: v.pipe(
      UsageEntrySchema,
      v.check((usage) => usage.role === "fixer", "fixer usage role is required"),
    ),
  }),
  v.strictObject({
    schemaVersion: v.literal(2),
    role: v.literal("reviewer"),
    report: ReviewerReportSchema,
    usage: v.pipe(
      UsageEntrySchema,
      v.check((usage) => usage.role === "reviewer", "reviewer usage role is required"),
    ),
  }),
]);
export type AgentArtifact = v.InferOutput<typeof AgentArtifactSchema>;

export const CandidateArtifactSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(2),
    verdict: v.picklist(["candidate", "deferred", "scope-violation"]),
    detail: v.string(),
    patch: v.string(),
    patchHash: v.union([v.literal(""), v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))]),
    paths: v.array(v.string()),
  }),
  v.check(
    (artifact) =>
      artifact.verdict === "candidate"
        ? artifact.patch !== "" && artifact.patchHash !== "" && artifact.paths.length > 0
        : artifact.patchHash === "",
    "candidate artifact verdict/hash relationship is invalid",
  ),
);
export type CandidateArtifact = v.InferOutput<typeof CandidateArtifactSchema>;

export function readArtifact<const TSchema extends v.GenericSchema>(
  path: string,
  schema: TSchema,
): v.InferOutput<TSchema> {
  const source = readFileSync(path);
  if (source.byteLength > MAX_ARTIFACT_BYTES) throw new Error(`${path} exceeds 4 MiB`);
  return v.parse(schema, JSON.parse(source.toString("utf8")));
}

export function writeArtifact<const TSchema extends v.GenericSchema>(
  path: string,
  schema: TSchema,
  value: v.InferInput<TSchema>,
): void {
  const parsed = v.parse(schema, value);
  const source = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(source) > MAX_ARTIFACT_BYTES) throw new Error(`${path} exceeds 4 MiB`);
  writeFileSync(path, source);
}
