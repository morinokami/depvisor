import assert from "node:assert/strict";
import { test } from "node:test";
import { requireModel, type ModelEnv } from "../src/agents/shared/model.ts";

test("normal runs require and preserve the configured model", () => {
  const env = { DEPVISOR_DRY_RUN: "false", DEPVISOR_LLM_MODEL: "anthropic/model" };
  assert.equal(requireModel(env), "anthropic/model");
});

test("dry-run ignores configured models and removes built-in provider credentials", () => {
  const env: ModelEnv = {
    DEPVISOR_DRY_RUN: " true ",
    DEPVISOR_LLM_MODEL: "anthropic/real-model",
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    OPENROUTER_API_KEY: "openrouter-secret",
  };
  assert.equal(requireModel(env), "openai/gpt-5.5");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
});

test("invalid nonempty dry-run values reach config parsing before model validation", () => {
  const env: ModelEnv = { DEPVISOR_DRY_RUN: "TRUE" };
  assert.equal(requireModel(env), "openai/gpt-5.5");
});

test("missing model still fails fast for an unset or false dry-run", () => {
  for (const dryRun of [undefined, "", "false"]) {
    assert.throws(
      () => requireModel({ DEPVISOR_DRY_RUN: dryRun }),
      /DEPVISOR_LLM_MODEL is not set/,
    );
  }
});
