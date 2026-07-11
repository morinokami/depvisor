import assert from "node:assert/strict";
import { test } from "node:test";
import * as v from "valibot";
import {
  DigestResult,
  digestPrompt,
  FixerResult,
  fixerPrompt,
  wantsSuggestions,
} from "../src/agents/shared/tasks.ts";
import type { Candidate } from "../src/core/types.ts";

const candidate = (updateType: Candidate["updateType"]): Candidate => ({
  name: "example",
  current: "1.0.0",
  latest: updateType === "patch" ? "1.0.1" : "1.1.0",
  kind: "prod",
  updateType,
  locations: ["", "packages/app"],
});

test("task result schemas keep the fixer verdict and optional digest feature contract", () => {
  assert.deepEqual(
    v.parse(FixerResult, {
      summary: "adapted",
      fixes_applied: ["changed call"],
      residual_risks: [],
      verdict: "fixed",
    }).verdict,
    "fixed",
  );
  assert.equal(
    v.parse(DigestResult, {
      summary: "update",
      upstream_changes: [],
      review_notes: [],
    }).relevant_new_features,
    undefined,
  );
});

test("fixerPrompt carries bounded failure context and the source-only contract", () => {
  const prompt = fixerPrompt(
    [candidate("minor")],
    [{ name: "test", run: "npm test" }],
    [{ name: "test", ok: false, code: 1, tail: "TypeError: old API" }],
    '- "example": "^1.0.0"\n+ "example": "^1.1.0"',
    "",
  );
  assert.match(prompt, /TypeError: old API/);
  assert.match(prompt, /packages\/app/);
  assert.match(prompt, /do not edit any package\.json/);
  assert.match(prompt, /Do not run them yourself/);
});

test("feature suggestions use one shared non-patch gate for prompt and rendering", () => {
  assert.equal(wantsSuggestions(true, [candidate("patch")]), false);
  assert.equal(wantsSuggestions(false, [candidate("minor")]), false);
  assert.equal(wantsSuggestions(true, [candidate("minor")]), true);

  const plain = digestPrompt([candidate("minor")], "notes", false, "");
  const suggested = digestPrompt([candidate("minor")], "notes", true, "");
  assert.doesNotMatch(plain, /relevant_new_features/);
  assert.match(suggested, /relevant_new_features/);
  assert.match(suggested, /notification only/);
});

test("the language knob adds one output-language sentence to both prompts, or nothing", () => {
  const digestEnglish = digestPrompt([candidate("minor")], "notes", false, "");
  const digestJa = digestPrompt([candidate("minor")], "notes", false, "ja");
  assert.doesNotMatch(digestEnglish, /BCP 47 tag/);
  assert.match(
    digestJa,
    /free-text field of the structured result in the language with BCP 47 tag `ja`/,
  );
  assert.match(digestJa, /untranslated/);

  const fixer = (language: string) =>
    fixerPrompt(
      [candidate("minor")],
      [{ name: "test", run: "npm test" }],
      [{ name: "test", ok: false, code: 1, tail: "boom" }],
      "diff",
      language,
    );
  assert.doesNotMatch(fixer(""), /BCP 47 tag/);
  assert.match(fixer("pt-BR"), /BCP 47 tag `pt-BR`/);
});
