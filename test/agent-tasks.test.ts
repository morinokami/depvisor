import assert from "node:assert/strict";
import { test } from "node:test";
import * as v from "valibot";
import {
  DigestResult,
  digestPrompt,
  FixerResult,
  fixerPrompt,
} from "../src/agents/shared/tasks.ts";
import type { DependencyChange } from "../src/core/types.ts";

function change(partial: Partial<DependencyChange> = {}): DependencyChange {
  return {
    name: "lru-cache",
    from: "10.4.3",
    to: "11.0.0",
    kind: "prod",
    updateType: "major",
    locations: [""],
    ...partial,
  };
}

test("prompts render one line per package: window, dev flag, workspaces", () => {
  const prompt = digestPrompt(
    [
      change(),
      change({
        name: "eslint",
        from: "8.0.0",
        to: "9.0.0",
        kind: "dev",
        locations: ["packages/app", "packages/lib"],
      }),
    ],
    "notes",
    false,
    "",
  );
  assert.match(prompt, /- lru-cache: 10\.4\.3 -> 11\.0\.0\n/);
  // The root location "" is not a workspace — it must not render a bracket.
  assert.doesNotMatch(prompt, /lru-cache: [^\n]*\[in/);
  assert.match(
    prompt,
    /- eslint: 8\.0\.0 -> 9\.0\.0 \(dev dependency\) \[in packages\/app, packages\/lib\]/,
  );
});

test("fixerPrompt shows only the FAILING steps' tails, plus the manifest hunks", () => {
  const prompt = fixerPrompt(
    [change()],
    [
      { name: "build", run: "npm run build" },
      { name: "test", run: "npm run test" },
    ],
    [
      { name: "build", ok: true, code: 0, tail: "built fine" },
      { name: "test", ok: false, code: 1, tail: "TypeError: cache.reset is not a function" },
    ],
    '-    "lru-cache": "^10.0.0"\n+    "lru-cache": "^11.0.0"',
    "",
  );
  assert.match(prompt, /- test \(exit 1\):\nTypeError: cache\.reset is not a function/);
  // A passing step's output is noise, not context.
  assert.doesNotMatch(prompt, /built fine/);
  // Manifest hunks are shown (lockfile diffs would swamp the context).
  assert.match(prompt, /"lru-cache": "\^11\.0\.0"/);
  // The workflow owns the authoritative verification run and dependency state.
  assert.match(prompt, /`npm run build`, `npm run test`/);
  assert.match(prompt, /Do not run them yourself/);
  assert.match(prompt, /do not edit any package\.json/);
});

test("fixerPrompt degrades a missing tail to an explicit placeholder", () => {
  const prompt = fixerPrompt(
    [change()],
    [{ name: "test", run: "npm run test" }],
    [{ name: "test", ok: false, code: null }],
    "diff",
    "",
  );
  assert.match(prompt, /- test \(exit null\):\n\(no output captured\)/);
});

test("digestPrompt mentions the committed repair only when one exists", () => {
  const repaired = digestPrompt([change()], "the notes text", true, "");
  const clean = digestPrompt([change()], "the notes text", false, "");
  assert.match(repaired, /bounded source repair has already been committed/);
  assert.doesNotMatch(clean, /repair/);
  // Release notes are injected but flagged as untrusted external text.
  assert.match(clean, /the notes text/);
  assert.match(clean, /UNTRUSTED external text/);
});

test("the language knob adds one output-language sentence to both prompts, or nothing", () => {
  const fixer = (language: string) =>
    fixerPrompt(
      [change()],
      [{ name: "test", run: "npm test" }],
      [{ name: "test", ok: false, code: 1, tail: "boom" }],
      "diff",
      language,
    );
  // Unset must stay bit-identical to before the knob existed.
  assert.doesNotMatch(fixer(""), /BCP 47 tag/);
  assert.match(fixer("pt-BR"), /BCP 47 tag `pt-BR`/);

  const digest = (language: string) => digestPrompt([change()], "notes", false, language);
  assert.doesNotMatch(digest(""), /BCP 47 tag/);
  assert.match(digest("ja"), /BCP 47 tag `ja`/);
  assert.match(digest("ja"), /untranslated/);
});

test("FixerResult: verdict is a closed picklist with an optional defer_reason", () => {
  const parsed = v.parse(FixerResult, {
    summary: "adapted call sites",
    fixes_applied: ["replaced cache.reset() with cache.clear()"],
    residual_risks: [],
    verdict: "defer",
    defer_reason: "needs a human decision",
  });
  assert.equal(parsed.verdict, "defer");
  assert.equal(parsed.defer_reason, "needs a human decision");
  // The workflow branches on the verdict, so a missing or invented verdict
  // must fail parsing rather than be defaulted.
  assert.equal(
    v.safeParse(FixerResult, { summary: "x", fixes_applied: [], residual_risks: [] }).success,
    false,
  );
  assert.equal(
    v.safeParse(FixerResult, {
      summary: "x",
      fixes_applied: [],
      residual_risks: [],
      verdict: "maybe",
    }).success,
    false,
  );
});

test("DigestResult: the three display fields, and no feature-suggestion contract", () => {
  const parsed = v.parse(DigestResult, {
    summary: "major lru-cache update",
    upstream_changes: [{ package: "lru-cache", note: "reset() removed" }],
    review_notes: ["check eviction behavior"],
  });
  assert.equal(parsed.upstream_changes[0]?.note, "reset() removed");
  // relevant_new_features is gone from the v2 contract: a model still emitting
  // it gets the key stripped, never surfaced downstream.
  const extra: Record<string, unknown> = v.parse(DigestResult, {
    summary: "s",
    upstream_changes: [],
    review_notes: [],
    relevant_new_features: ["stale field"],
  });
  assert.ok(!("relevant_new_features" in extra));
  // Each display field is required — the report renderer never defaults them.
  assert.equal(v.safeParse(DigestResult, { summary: "s", upstream_changes: [] }).success, false);
  assert.equal(
    v.safeParse(DigestResult, {
      summary: "s",
      upstream_changes: [{ package: "p" }], // note missing
      review_notes: [],
    }).success,
    false,
  );
});
