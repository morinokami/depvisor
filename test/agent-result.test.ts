import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { AgentResultSchema, validAgentVerdict } from "../src/core/agent-result.ts";

const ready = v.parse(AgentResultSchema, {
  verdict: "ready",
  summary: "No repair needed.",
  upstream_changes: [],
  changes_made: [],
  verification: [{ command: "pnpm test", outcome: "passed", evidence: "exit 0" }],
  risks: [],
});

test("accepts an evidence-shaped ready result", () => {
  assert.equal(validAgentVerdict(ready), true);
});

test("requires a concrete reason when deferring", () => {
  assert.equal(validAgentVerdict({ ...ready, verdict: "defer" }), false);
  assert.equal(
    validAgentVerdict({ ...ready, verdict: "defer", defer_reason: "Needs a peer bump." }),
    true,
  );
});
