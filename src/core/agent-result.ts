/** Structured evidence the autonomous repair agent hands to the publisher. */

import * as v from "valibot";

export const AgentResultSchema = v.object({
  verdict: v.picklist(["ready", "defer"]),
  summary: v.string(),
  upstream_changes: v.array(
    v.object({
      dependency: v.string(),
      change: v.string(),
      relevance: v.string(),
      evidence_url: v.optional(v.string()),
    }),
  ),
  changes_made: v.array(v.string()),
  verification: v.array(
    v.object({
      command: v.string(),
      outcome: v.picklist(["passed", "failed", "not-run"]),
      evidence: v.string(),
    }),
  ),
  risks: v.array(v.string()),
  defer_reason: v.optional(v.string()),
});

export type AgentResult = v.InferOutput<typeof AgentResultSchema>;

export function validAgentVerdict(result: AgentResult): boolean {
  return result.verdict !== "defer" || Boolean(result.defer_reason?.trim());
}
