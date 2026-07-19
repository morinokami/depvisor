import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import {
  SelfCheckFindingsSchema,
  parseFindingsFile,
  parseOutputsLine,
  planFindings,
  renderIssueBody,
  renderIssueTitle,
  resolveEvidence,
} from "../src/core/self-check.ts";

const finding = {
  title: "Repeated publish-failed on Renovate PRs",
  detail: "Three runs hit publish-failed with the same force-with-lease rejection.",
  evidence_run_ids: [101, 102],
  suggested_action: "Check whether the fix push races the updater's rebase.",
};

const ZWSP = "\u{200B}";

test("parses the current outputs echo with token and cost fields", () => {
  const log = [
    '2026-07-17T01:02:03.0000000Z ##[group]Run echo "status=$STATUS failed=$FAILED fixed=$FIXED pr=$PR_URL total_tokens=$TOTAL_TOKENS est_cost_usd=$EST_COST_USD"',
    "2026-07-17T01:02:03.0000000Z ##[endgroup]",
    "2026-07-17T01:02:04.0000000Z status=fix-pushed failed=false fixed=true pr=https://github.com/o/r/pull/5 total_tokens=48211 est_cost_usd=0.412335",
  ].join("\n");
  assert.deepEqual(parseOutputsLine(log), {
    status: "fix-pushed",
    failed: false,
    fixed: true,
    totalTokens: 48_211,
    estCostUsd: 0.412335,
  });
});

test("parses the pre-cost echo and leaves the missing fields null", () => {
  const parsed = parseOutputsLine(
    "2026-07-01T00:00:00Z status=reviewed failed=false fixed=false pr=https://github.com/o/r/pull/4",
  );
  assert.deepEqual(parsed, {
    status: "reviewed",
    failed: false,
    fixed: false,
    totalTokens: null,
    estCostUsd: null,
  });
});

test("skips unexpanded command headers and non-status lines", () => {
  assert.equal(
    parseOutputsLine('Run echo "status=$STATUS failed=$FAILED fixed=$FIXED pr=$PR_URL"'),
    null,
  );
  assert.equal(parseOutputsLine("plain log line with no echo"), null);
});

test("nulls malformed token and cost values instead of guessing", () => {
  const parsed = parseOutputsLine(
    "status=reviewed failed=maybe fixed=false pr=x total_tokens=lots est_cost_usd=",
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

test("never plans the same title twice in one batch", () => {
  const twice = planFindings(
    [finding, { ...finding, detail: "same title, different text" }],
    new Set(),
    new Set([101, 102]),
    "https://github.com",
    "o/r",
  );
  assert.deepEqual(
    twice.map((planned) => planned.action),
    ["create", "skip-duplicate"],
  );

  const truncated = planFindings(
    [
      { ...finding, title: `${"a".repeat(120)}-first` },
      { ...finding, title: `${"a".repeat(120)}-second` },
    ],
    new Set(),
    new Set([101, 102]),
    "https://github.com",
    "o/r",
  );
  assert.deepEqual(
    truncated.map((planned) => planned.action),
    ["create", "skip-duplicate"],
  );
});

test("skips a title that is already open and caps the batch", () => {
  const planned = planFindings(
    [finding, { ...finding, title: "Fresh topic" }, { ...finding, title: "Third topic" }],
    new Set([renderIssueTitle(finding)]),
    new Set([101, 102]),
    "https://github.com",
    "o/r",
  );
  assert.deepEqual(
    planned.map((entry) => [entry.action, entry.title]),
    [
      ["skip-duplicate", renderIssueTitle(finding)],
      ["create", "self-check: Fresh topic"],
    ],
  );
});

test("an unresolved finding reserves no title", () => {
  const planned = planFindings(
    [{ ...finding, evidence_run_ids: [999] }, finding],
    new Set(),
    new Set([101, 102]),
    "https://github.com",
    "o/r",
  );
  assert.deepEqual(
    planned.map((entry) => entry.action),
    ["drop-unresolved", "create"],
  );
});

test("defuses agent-authored links, autolinks, mentions, and refs in prose", () => {
  const body = renderIssueBody(
    {
      ...finding,
      detail:
        "see [trusted-looking link](https://attacker.example/phish) or www.evil.example, ping @someone about #42",
      suggested_action: "read <https://attacker.example/more> first",
    },
    [{ runId: 101, url: "https://github.com/o/r/actions/runs/101" }],
    null,
  );
  assert.ok(!body.includes("](https://attacker.example/phish)"));
  assert.ok(body.includes("]\\("));
  assert.ok(!body.includes("https://attacker.example"));
  assert.ok(body.includes(`https:${ZWSP}//attacker.example`));
  assert.ok(!body.includes("www.evil"));
  assert.ok(body.includes(`www${ZWSP}.evil.example`));
  assert.ok(!body.includes("@someone"));
  assert.ok(body.includes(`@${ZWSP}someone`));
  assert.ok(!body.includes("#42"));
  assert.ok(body.includes(`#${ZWSP}42`));
  assert.ok(body.includes("- [run 101](https://github.com/o/r/actions/runs/101)"));
});

test("renders reporter-built evidence links and neutralized markers", () => {
  const body = renderIssueBody(
    { ...finding, detail: "hides a marker <!-- inject --> here" },
    [{ runId: 101, url: "https://github.com/o/r/actions/runs/101" }],
    "https://github.com/o/r/actions/runs/999",
  );
  assert.ok(body.includes("- [run 101](https://github.com/o/r/actions/runs/101)"));
  assert.ok(!body.includes("<!--"));
  assert.ok(body.includes("https://github.com/o/r/actions/runs/999"));
});

test("renders agent-authored raw HTML as inert text", () => {
  const body = renderIssueBody(
    {
      ...finding,
      detail: 'click <a href="//attacker.example/phish">trusted-looking link</a> now',
      suggested_action: 'or <a href="https&#58;//attacker.example/x">this</a>',
    },
    [{ runId: 101, url: "https://github.com/o/r/actions/runs/101" }],
    null,
  );
  assert.ok(!body.includes("<a "));
  assert.ok(!body.includes("</a>"));
  assert.ok(body.includes("&lt;a href="));
  // An agent-supplied entity must not survive to decode inside an attribute,
  // and its leftover #58 must not become an issue reference.
  assert.ok(!body.includes("https&#58;//attacker.example"));
  assert.ok(!body.includes("#58;//attacker.example"));
  assert.ok(body.includes(`https&amp;#${ZWSP}58;//attacker.example`));
  assert.ok(body.includes("- [run 101](https://github.com/o/r/actions/runs/101)"));
});

test("prefixes and bounds the issue title", () => {
  const title = renderIssueTitle({ ...finding, title: "a".repeat(300) });
  assert.ok(title.startsWith("self-check: "));
  assert.ok(title.length <= 12 + 120);
});
