import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanReportText,
  escapeStepSummaryText,
  linkifyRepoPaths,
  repoFileUrl,
} from "../src/core/text.ts";

test("report text separates lines and prevents marker injection", () => {
  assert.equal(cleanReportText("line1\nline2"), "line1 line2");
  assert.equal(cleanReportText("<!-- marker -->"), "&lt;!-- marker --&gt;");
});

const SHA = "a".repeat(40);

test("repo file URLs pin one commit and encode every path segment", () => {
  assert.equal(
    repoFileUrl("https://github.com", "owner/repo", SHA, "apps/store-sync/src/secret.ts"),
    `https://github.com/owner/repo/blob/${SHA}/apps/store-sync/src/secret.ts`,
  );
  assert.equal(
    repoFileUrl("https://github.com", "owner/repo", SHA, "docs/a b/(note).md"),
    `https://github.com/owner/repo/blob/${SHA}/docs/a%20b/%28note%29.md`,
  );
});

test("repo file URLs refuse malformed components", () => {
  assert.equal(repoFileUrl("https://github.com", "owner/repo/extra", SHA, "a.ts"), null);
  assert.equal(repoFileUrl("https://github.com", "owner/repo", "main", "a.ts"), null);
  assert.equal(repoFileUrl("https://github.com", "owner/repo", SHA, "../a.ts"), null);
  assert.equal(repoFileUrl("https://github.com", "owner/repo", SHA, "/etc/passwd"), null);
});

test("repo file URLs fail closed on unencodable paths instead of throwing", () => {
  assert.equal(repoFileUrl("https://github.com", "owner/repo", SHA, "src/\ud800.ts"), null);
});

const url = (path: string): string | null =>
  path === "src/index.ts" ? `https://example.test/${path}` : null;

test("linkification rewrites only backticked known-file mentions", () => {
  assert.equal(
    linkifyRepoPaths("Edited `src/index.ts` for the new API.", url),
    "Edited [`src/index.ts`](https://example.test/src/index.ts) for the new API.",
  );
  assert.equal(
    linkifyRepoPaths("`src/missing.ts` and plain src/index.ts stay literal.", url),
    "`src/missing.ts` and plain src/index.ts stay literal.",
  );
  assert.equal(
    linkifyRepoPaths("Bumped `next@15.1.2` here.", () => null),
    "Bumped `next@15.1.2` here.",
  );
});

test("linkification never hands unsafe tokens to the URL builder", () => {
  const seen: string[] = [];
  const collect = (path: string): null => {
    seen.push(path);
    return null;
  };
  linkifyRepoPaths("`../escape` `/abs` `a\\b` `src/ok.ts` ``", collect);
  assert.deepEqual(seen, ["src/ok.ts"]);
});

test("step-summary text renders model-authored Markdown as one literal line", () => {
  const escaped = escapeStepSummaryText("ok\n# injected <script> [link](https://example.com)");
  assert.doesNotMatch(escaped, /\n/);
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /\\# injected/);
  assert.match(escaped, /\\\[link\\\]/);
});
