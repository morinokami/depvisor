import { defineAgent } from "@flue/runtime";
import instructions from "./self-check.md" with { type: "markdown" };
import { requireModel } from "../shared/env.ts";

export const description =
  "Reads a bounded summary of recent depvisor workflow runs and reports at most two " +
  "evidence-grounded operational findings, or none for a healthy period.";

/**
 * Deliberately weaker than the repair agent: no local() sandbox, no tools, no
 * checkout, no network beyond the model provider. The analyst only sees the
 * collector-built envelope in its prompt and returns structured findings that
 * the token-holding reporter re-validates.
 */
export default defineAgent(() => ({
  model: requireModel(process.env),
  instructions,
}));
