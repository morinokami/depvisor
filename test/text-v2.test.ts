import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanReportText, escapeStepSummaryText } from "../src/core/text.ts";

test("report text separates lines and prevents marker injection", () => {
  assert.equal(cleanReportText("line1\nline2"), "line1 line2");
  assert.equal(cleanReportText("<!-- marker -->"), "&lt;!-- marker --&gt;");
});

test("step-summary text renders model-authored Markdown as one literal line", () => {
  const escaped = escapeStepSummaryText("ok\n# injected <script> [link](https://example.com)");
  assert.doesNotMatch(escaped, /\n/);
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /\\# injected/);
  assert.match(escaped, /\\\[link\\\]/);
});
