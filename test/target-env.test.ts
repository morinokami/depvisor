import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetEnv } from "../src/core/target-env.ts";
import { runVerification } from "../src/core/verify.ts";

test("targetEnv strips the built-in provider keys and the named custom key", () => {
  const env = targetEnv({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-1",
    ANTHROPIC_API_KEY: "sk-2",
    OPENROUTER_API_KEY: "sk-3",
    DEPVISOR_LLM_KEY_ENV: "MY_PROVIDER_KEY",
    MY_PROVIDER_KEY: "sk-4",
    NPM_TOKEN: "kept-on-purpose", // user-supplied registry auth stays
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NPM_TOKEN, "kept-on-purpose");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.MY_PROVIDER_KEY, undefined);
  assert.equal(env.DEPVISOR_LLM_KEY_ENV, undefined);
});

test("targetEnv does not mutate the process env it reads from", () => {
  const base = { OPENAI_API_KEY: "sk-1" };
  targetEnv(base);
  assert.equal(base.OPENAI_API_KEY, "sk-1");
});

test("verification subprocesses cannot read the LLM provider key", () => {
  // The exact leak the review reproduced: `printenv OPENAI_API_KEY` as a
  // verification command. The workflow process holds the key (Flue reads it);
  // the target child must not.
  const repo = mkdtempSync(join(tmpdir(), "depvisor-target-env-"));
  process.env.OPENAI_API_KEY = "sk-secret";
  process.env.DEPVISOR_LLM_KEY_ENV = "CUSTOM_KEY";
  process.env.CUSTOM_KEY = "sk-custom";
  try {
    const results = runVerification(repo, [
      { name: "leak", run: 'test -z "$OPENAI_API_KEY" && test -z "$CUSTOM_KEY"' },
    ]);
    assert.equal(results[0]?.ok, true, "the child saw a provider key");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEPVISOR_LLM_KEY_ENV;
    delete process.env.CUSTOM_KEY;
  }
});
