/**
 * Trusted v2 configuration. The coordinator reads this file from the immutable
 * PR base-tip SHA through the GitHub API; target checkouts are never consulted.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import * as v from "valibot";
import { UpdateTypeSchema } from "./types.ts";

const UpdateTypesSchema = v.pipe(v.array(UpdateTypeSchema), v.maxLength(5));
const CommandSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000));
const CommandsSchema = v.pipe(v.array(CommandSchema), v.maxLength(50));
const ActorSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));
const MAX_CONFIG_BYTES = 64 * 1024;

const RepairConfigSchema = v.strictObject({
  enabled: v.boolean(),
  update_types: v.optional(UpdateTypesSchema, ["patch", "minor", "major", "digest"]),
});

const VerificationConfigSchema = v.strictObject({
  prepare: v.optional(CommandsSchema, []),
  commands: v.optional(CommandsSchema, []),
});

const DependabotConfigSchema = v.strictObject({ enabled: v.optional(v.boolean(), true) });
const RenovateConfigSchema = v.strictObject({
  enabled: v.optional(v.boolean(), true),
  trusted_actors: v.optional(v.pipe(v.array(ActorSchema), v.maxLength(50)), ["renovate[bot]"]),
  rebase_label: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
});

const ReportConfigSchema = v.strictObject({
  enabled: v.boolean(),
  update_types: v.optional(UpdateTypesSchema, ["minor", "major"]),
  language: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)), "en"),
  suggest_features: v.optional(v.boolean(), false),
});

const CostConfigSchema = v.strictObject({
  max_dependencies_per_pr: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
    20,
  ),
  max_llm_calls_per_pr: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2)),
    2,
  ),
});

export const DepvisorConfigSchema = v.strictObject({
  version: v.literal(2),
  repair: RepairConfigSchema,
  verification: v.optional(VerificationConfigSchema, { prepare: [], commands: [] }),
  updaters: v.optional(
    v.strictObject({
      dependabot: v.optional(DependabotConfigSchema, { enabled: true }),
      renovate: v.optional(RenovateConfigSchema, {
        enabled: true,
        trusted_actors: ["renovate[bot]"],
      }),
    }),
    {
      dependabot: { enabled: true },
      renovate: { enabled: true, trusted_actors: ["renovate[bot]"] },
    },
  ),
  report: ReportConfigSchema,
  cost: v.optional(CostConfigSchema, {
    max_dependencies_per_pr: 20,
    max_llm_calls_per_pr: 2,
  }),
});

export type DepvisorConfig = v.InferOutput<typeof DepvisorConfigSchema>;

export type ConfigResult =
  | { ok: true; config: DepvisorConfig; digest: string }
  | { ok: false; error: string };

export function parseConfig(source: string | null): ConfigResult {
  if (source === null || source.trim() === "") {
    return { ok: false, error: ".github/depvisor.yml is missing at the PR base tip" };
  }
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) {
    return { ok: false, error: ".github/depvisor.yml exceeds 64 KiB" };
  }
  try {
    const raw: unknown = parseYaml(source);
    const config = v.parse(DepvisorConfigSchema, raw);
    const digest = createHash("sha256").update(source).digest("hex");
    return { ok: true, config, digest };
  } catch (error) {
    const message = Error.isError(error) ? error.message : String(error);
    return { ok: false, error: `invalid .github/depvisor.yml: ${message}` };
  }
}
