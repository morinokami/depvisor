import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { AgentResultSchema } from "../src/core/agent-result.ts";

const ready = {
  verdict: "ready",
  summary: "No fix needed.",
  upstream_changes: [],
  changes_made: [],
  verification: [{ command: "pnpm test", outcome: "passed", evidence: "exit 0" }],
  risks: [],
};

test("accepts an evidence-shaped ready result", () => {
  assert.deepEqual(v.parse(AgentResultSchema, ready), ready);
});

test("requires a concrete reason when deferring", () => {
  assert.equal(v.safeParse(AgentResultSchema, { ...ready, verdict: "defer" }).success, false);
  assert.equal(
    v.safeParse(AgentResultSchema, { ...ready, verdict: "defer", defer_reason: " " }).success,
    false,
  );
  assert.equal(
    v.safeParse(AgentResultSchema, {
      ...ready,
      verdict: "defer",
      defer_reason: "Needs a peer bump.",
    }).success,
    true,
  );
});

test("caps evidence and list sizes", () => {
  const risks = Array.from({ length: 201 }, () => "risk");
  assert.equal(v.safeParse(AgentResultSchema, { ...ready, risks }).success, false);
  const verification = Array.from({ length: 101 }, () => ({
    command: "true",
    outcome: "passed",
    evidence: "exit 0",
  }));
  assert.equal(v.safeParse(AgentResultSchema, { ...ready, verification }).success, false);
});
