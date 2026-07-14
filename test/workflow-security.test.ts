import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/depvisor.yml", "utf8");

test("the v2 workflow uses the trusted workflow_run/reusable boundary", () => {
  const start = readFileSync("start.md", "utf8");
  assert.match(start, /workflow_run:/);
  assert.doesNotMatch(start, /pull_request_target:/);
  assert.doesNotMatch(workflow, /secrets:\s*inherit/);
  assert.match(workflow, /permissions: \{\}/);
});

test("every workflow action is pinned and checkout credentials never persist", () => {
  const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1] ?? "");
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);

  const checkouts = [
    ...workflow.matchAll(
      /- uses: actions\/checkout@[\s\S]*?(?=\n\s*- (?:uses:|name:|working-directory:|if:)|\n\s{2}\w|$)/g,
    ),
  ];
  assert.ok(checkouts.length > 0);
  for (const checkout of checkouts) assert.match(checkout[0], /persist-credentials:\s*false/);

  const depvisorCheckouts = checkouts.filter((checkout) => /path:\s*depvisor/.test(checkout[0]));
  assert.ok(depvisorCheckouts.length > 0);
  for (const checkout of depvisorCheckouts) {
    assert.match(checkout[0], /job\.workflow_repository/);
    assert.match(checkout[0], /job\.workflow_sha/);
  }
  assert.doesNotMatch(workflow, /depvisor_ref|DEPVISOR_SOURCE_REPOSITORY/);
});

test("LLM, target execution, and publisher credentials remain in separate jobs", () => {
  const publisher = workflow.slice(workflow.indexOf("  publish:"));
  assert.doesNotMatch(publisher, /DEPVISOR_TARGET_REPO/);
  assert.doesNotMatch(publisher, /DEPVISOR_LLM_API_KEY/);
  assert.match(publisher, /DEPVISOR_PUBLISH_TOKEN/);

  const beforePublisher = workflow.slice(0, workflow.indexOf("  publish:"));
  assert.doesNotMatch(beforePublisher, /DEPVISOR_PUBLISH_TOKEN/);
  assert.match(beforePublisher, /DEPVISOR_LLM_API_KEY/);
});
