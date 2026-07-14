import * as v from "valibot";

export const GitShaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
const RepositorySchema = v.pipe(
  v.string(),
  v.maxLength(200),
  v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
const RefSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1_024), v.regex(/^[^\p{Cc}]+$/u));

export const ProviderSchema = v.picklist(["dependabot", "renovate"]);
export type Provider = v.InferOutput<typeof ProviderSchema>;

export const CapabilitySchema = v.picklist([
  "generic-review",
  "identified",
  "repair-safe",
  "deep-evidence",
]);

export const UpdateTypeSchema = v.picklist(["patch", "minor", "major", "digest", "unknown"]);
export type UpdateType = v.InferOutput<typeof UpdateTypeSchema>;

export const EvidenceReferenceSchema = v.strictObject({
  kind: v.picklist([
    "pr-diff",
    "release-note",
    "package-diff",
    "source-diff",
    "registry",
    "advisory",
    "ci",
  ]),
  source: v.string(),
  summary: v.string(),
  untrusted: v.literal(true),
});

export const PullRequestTargetSchema = v.strictObject({
  repositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  repository: RepositorySchema,
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  baseRef: RefSchema,
  baseTipSha: GitShaSchema,
  mergeBaseSha: GitShaSchema,
  prHeadSha: GitShaSchema,
  updaterHeadSha: GitShaSchema,
  headRepository: RepositorySchema,
  headRef: RefSchema,
  provider: ProviderSchema,
});

export const DependencyChangeSchema = v.strictObject({
  ecosystem: v.string(),
  manager: v.string(),
  package: v.string(),
  from: v.nullable(v.string()),
  to: v.nullable(v.string()),
  kind: v.picklist(["runtime", "development", "unknown"]),
  directness: v.picklist(["direct", "transitive", "unknown"]),
  manifests: v.array(v.string()),
  lockfiles: v.array(v.string()),
  protectedPaths: v.array(v.string()),
  capability: CapabilitySchema,
  evidence: v.array(EvidenceReferenceSchema),
});
export type DependencyChange = v.InferOutput<typeof DependencyChangeSchema>;

export const VerificationStepResultSchema = v.strictObject({
  phase: v.picklist(["baseline", "head", "candidate"]),
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2)),
  name: v.string(),
  ok: v.boolean(),
  code: v.nullable(v.number()),
});
export type VerificationStepResult = v.InferOutput<typeof VerificationStepResultSchema>;

export const UsageEntrySchema = v.strictObject({
  role: v.picklist(["fixer", "reviewer"]),
  input: v.number(),
  output: v.number(),
  cacheRead: v.number(),
  cacheWrite: v.number(),
  totalTokens: v.number(),
  costUsd: v.number(),
  model: v.string(),
});
export type UsageEntry = v.InferOutput<typeof UsageEntrySchema>;

export const V2StatusSchema = v.picklist([
  "in-progress",
  "no-target",
  "not-updater",
  "policy-skipped",
  "reviewed",
  "repair-not-needed",
  "repair-applied",
  "updater-refresh-requested",
  "stale-base",
  "stale-head",
  "human-takeover",
  "unsupported-provider",
  "untrusted-updater",
  "bad-config",
  "verification-unavailable",
  "repair-unsupported",
  "updater-refresh-required",
  "baseline-red",
  "verification-unstable",
  "failure-not-reproduced",
  "repair-deferred",
  "verification-failed",
  "scope-violation",
  "unexpected-commits",
  "publish-failed",
]);
export type V2Status = v.InferOutput<typeof V2StatusSchema>;

export const V2ResultSchema = v.strictObject({
  status: V2StatusSchema,
  pr: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  analyzedBaseTipSha: v.nullable(GitShaSchema),
  analyzedPrHeadSha: v.nullable(GitShaSchema),
  updaterHeadSha: v.nullable(GitShaSchema),
  publishedHeadSha: v.nullable(GitShaSchema),
  provider: v.nullable(ProviderSchema),
  changes: v.array(DependencyChangeSchema),
  repairApplied: v.boolean(),
  verification: v.array(VerificationStepResultSchema),
  reportUrl: v.nullable(v.string()),
  usage: v.array(UsageEntrySchema),
});
