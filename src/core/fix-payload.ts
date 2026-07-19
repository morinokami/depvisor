import { readFileSync, writeFileSync } from "node:fs";
import * as v from "valibot";
import { AgentResultSchema } from "./agent-result.ts";
import { MAX_FIX_FILES } from "./git.ts";

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Shape of the captured fix. The schemas live here rather than in git.ts
 * because the pre-install credential gate loads git.ts before `pnpm install`
 * exists — git.ts must stay free of installable imports, so it re-exports
 * these types type-only while the capture limit constant flows the other way.
 */
const NewFixFileSchema = v.object({
  path: v.string(),
  contentBase64: v.string(),
  executable: v.boolean(),
  symlink: v.boolean(),
});

export type NewFixFile = v.InferOutput<typeof NewFixFileSchema>;

const FixChangesSchema = v.object({
  patch: v.string(),
  newFiles: v.pipe(v.array(NewFixFileSchema), v.maxLength(MAX_FIX_FILES)),
  paths: v.pipe(v.array(v.string()), v.maxLength(MAX_FIX_FILES)),
});

export type FixChanges = v.InferOutput<typeof FixChangesSchema>;

/**
 * The token-free workflow → publisher handoff. The agent and changes shapes
 * come from the same schemas the workflow already enforced; the publisher
 * re-validates the whole file against them before trusting any field, without
 * maintaining a second hand-written copy of the shape.
 */
const FixPayloadSchema = v.object({
  version: v.literal(2),
  repository: v.string(),
  prNumber: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  prUrl: v.string(),
  headRepository: v.string(),
  headRef: v.string(),
  headSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
  agent: AgentResultSchema,
  changes: FixChangesSchema,
});

export type FixPayload = v.InferOutput<typeof FixPayloadSchema>;

export function writeFixPayload(path: string, payload: FixPayload): void {
  writeFileSync(path, JSON.stringify(payload));
}

export function readFixPayload(path: string): FixPayload {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
    throw new Error("Invalid fix payload: file is too large");
  }
  return v.parse(FixPayloadSchema, JSON.parse(text));
}
