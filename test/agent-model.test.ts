import assert from "node:assert/strict";
import { test } from "node:test";
import { requireModel } from "../src/agents/shared/model.ts";

test("requireModel returns the configured model verbatim", () => {
  assert.equal(
    requireModel({ DEPVISOR_LLM_MODEL: "anthropic/claude-sonnet-5" }),
    "anthropic/claude-sonnet-5",
  );
});

test("requireModel fails fast when the model is unset or empty — no silent default", () => {
  // A silent default model would be a silent cost/behavior decision; the empty
  // string is what the composite action forwards for an unset input.
  for (const env of [{}, { DEPVISOR_LLM_MODEL: undefined }, { DEPVISOR_LLM_MODEL: "" }]) {
    assert.throws(() => requireModel(env), /DEPVISOR_LLM_MODEL is not set/);
  }
});
