import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import {
  SelfCheckFindingsSchema,
  actionsRunUrl,
  parseFindingsFile,
  parseOutputsLine,
  renderIssueBody,
  renderIssueTitle,
  resolveEvidence,
} from "../src/core/self-check.ts";

const finding = {
  title: "Repeated publish-failed on Renovate PRs",
  detail: "Three runs hit publish-failed with the same force-with-lease rejection.",
  evidence_run_ids: [101, 102],
  suggested_action: "Check whether the repair push races the updater's rebase.",
};

test("parses the current outputs echo with token and cost fields", () => {
  const log = [
    '2026-07-17T01:02:03.0000000Z ##[group]Run echo "status=$STATUS failed=$FAILED repaired=$REPAIRED pr=$PR_URL total_tokens=$TOTAL_TOKENS est_cost_usd=$EST_COST_USD"',
    "2026-07-17T01:02:03.0000000Z ##[endgroup]",
    "2026-07-17T01:02:04.0000000Z status=repair-published failed=false repaired=true pr=https://github.com/o/r/pull/5 total_tokens=48211 est_cost_usd=0.412335",
  ].join("\n");
  assert.deepEqual(parseOutputsLine(log), {
    status: "repair-published",
    failed: false,
    repaired: true,
    totalTokens: 48_211,
    estCostUsd: 0.412335,
  });
});

test("parses the pre-cost echo and leaves the missing fields null", () => {
  const parsed = parseOutputsLine(
    "2026-07-01T00:00:00Z status=reviewed failed=false repaired=false pr=https://github.com/o/r/pull/4",
  );
  assert.deepEqual(parsed, {
    status: "reviewed",
    failed: false,
    repaired: false,
    totalTokens: null,
    estCostUsd: null,
  });
});

test("skips unexpanded command headers and non-status lines", () => {
  assert.equal(
    parseOutputsLine('Run echo "status=$STATUS failed=$FAILED repaired=$REPAIRED pr=$PR_URL"'),
    null,
  );
  assert.equal(parseOutputsLine("plain log line with no echo"), null);
});

test("nulls malformed token and cost values instead of guessing", () => {
  const parsed = parseOutputsLine(
    "status=reviewed failed=maybe repaired=false pr=x total_tokens=lots est_cost_usd=",
  );
  assert.ok(parsed);
  assert.equal(parsed.failed, null);
  assert.equal(parsed.totalTokens, null);
  assert.equal(parsed.estCostUsd, null);
});

test("accepts an empty findings list and caps the count at two", () => {
  assert.deepEqual(v.parse(SelfCheckFindingsSchema, { findings: [] }).findings, []);
  assert.equal(
    v.safeParse(SelfCheckFindingsSchema, { findings: [finding, finding, finding] }).success,
    false,
  );
});

test("requires at least one evidence run id per finding", () => {
  assert.equal(
    v.safeParse(SelfCheckFindingsSchema, { findings: [{ ...finding, evidence_run_ids: [] }] })
      .success,
    false,
  );
});

test("parses only a versioned findings handoff", () => {
  const text = JSON.stringify({ version: 1, findings: [finding] });
  assert.equal(parseFindingsFile(text).length, 1);
  assert.throws(() => parseFindingsFile(JSON.stringify({ findings: [finding] })));
  assert.throws(() => parseFindingsFile("not json"));
});

test("builds actions run URLs from validated components only", () => {
  assert.equal(
    actionsRunUrl("https://github.com", "o/r", 7),
    "https://github.com/o/r/actions/runs/7",
  );
  assert.equal(actionsRunUrl("http://github.com", "o/r", 7), null);
  assert.equal(actionsRunUrl("https://github.com", "o/r/evil", 7), null);
  assert.equal(actionsRunUrl("https://github.com", "o/r", 0), null);
});

test("rejects a finding when any cited run is uncollected", () => {
  const collected = new Set([101, 102]);
  const server = "https://github.com";
  assert.deepEqual(resolveEvidence(finding, collected, server, "o/r"), [
    { runId: 101, url: "https://github.com/o/r/actions/runs/101" },
    { runId: 102, url: "https://github.com/o/r/actions/runs/102" },
  ]);
  assert.equal(
    resolveEvidence({ ...finding, evidence_run_ids: [101, 999] }, collected, server, "o/r"),
    null,
  );
  assert.equal(resolveEvidence(finding, collected, server, "o/r/evil"), null);
});

test("deduplicates repeated evidence citations in order", () => {
  const evidence = resolveEvidence(
    { ...finding, evidence_run_ids: [102, 101, 102] },
    new Set([101, 102]),
    "https://github.com",
    "o/r",
  );
  assert.deepEqual(
    evidence?.map((entry) => entry.runId),
    [102, 101],
  );
});

test("defuses agent-authored links, autolinks, and mentions in prose", () => {
  const body = renderIssueBody(
    {
      ...finding,
      detail:
        "see [trusted-looking link](https://attacker.example/phish) or www.evil.example, ping @someone",
      suggested_action: "read <https://attacker.example/more> first",
    },
    [{ runId: 101, url: "https://github.com/o/r/actions/runs/101" }],
    null,
  );
  assert.ok(!body.includes("](https://attacker.example/phish)"));
  assert.ok(body.includes("]\\("));
  assert.ok(!body.includes("https://attacker.example"));
  assert.ok(body.includes("https&#58;//attacker.example"));
  assert.ok(!/\bwww\./.test(body));
  assert.ok(!body.includes("@someone"));
  assert.ok(body.includes("&#64;someone"));
  assert.ok(body.includes("- [run 101](https://github.com/o/r/actions/runs/101)"));
});

test("renders reporter-built evidence links and neutralized markers", () => {
  const body = renderIssueBody(
    { ...finding, detail: "hides a marker <!-- inject --> here" },
    [{ runId: 101, url: "https://github.com/o/r/actions/runs/101" }],
    "https://github.com/o/r/actions/runs/999",
  );
  assert.ok(body.includes("- [run 101](https://github.com/o/r/actions/runs/101)"));
  assert.ok(body.includes("&lt;!--"));
  assert.ok(!body.includes("<!--"));
  assert.ok(body.includes("https://github.com/o/r/actions/runs/999"));
});

test("prefixes and bounds the issue title", () => {
  const title = renderIssueTitle({ ...finding, title: "a".repeat(300) });
  assert.ok(title.startsWith("self-check: "));
  assert.ok(title.length <= 12 + 120);
});
