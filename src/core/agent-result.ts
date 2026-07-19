/** Structured evidence the autonomous repair agent hands to the publisher. */

import * as v from "valibot";

const MAX_EVIDENCE_ENTRIES = 100;
const MAX_LIST_ENTRIES = 200;

/**
 * One schema for both boundaries: the workflow validates the model's result
 * against it, and the publisher re-validates the same shape inside the repair
 * payload. The size caps and the defer_reason rule live here so an invalid
 * result is corrected at the model boundary instead of failing publication.
 */
export const AgentResultSchema = v.pipe(
  v.object({
    verdict: v.picklist(["ready", "defer"]),
    summary: v.string(),
    upstream_changes: v.pipe(
      v.array(
        v.object({
          dependency: v.string(),
          change: v.string(),
          relevance: v.string(),
          evidence_url: v.optional(v.string()),
        }),
      ),
      v.maxLength(MAX_EVIDENCE_ENTRIES),
    ),
    changes_made: v.pipe(v.array(v.string()), v.maxLength(MAX_LIST_ENTRIES)),
    verification: v.pipe(
      v.array(
        v.object({
          command: v.string(),
          outcome: v.picklist(["passed", "failed", "not-run"]),
          evidence: v.string(),
        }),
      ),
      v.maxLength(MAX_EVIDENCE_ENTRIES),
    ),
    risks: v.pipe(v.array(v.string()), v.maxLength(MAX_LIST_ENTRIES)),
    defer_reason: v.optional(v.string()),
  }),
  v.check(
    (result) => result.verdict !== "defer" || Boolean(result.defer_reason?.trim()),
    "A defer verdict requires a non-empty defer_reason",
  ),
);

export type AgentResult = v.InferOutput<typeof AgentResultSchema>;
