import assert from "node:assert/strict";
import test from "node:test";
import { decidePolicy, updateTypeFor } from "../src/core/policy.ts";
import { parseConfig } from "../src/core/config.ts";
import type { DependencyChange } from "../src/core/types.ts";

function change(from: string | null, to: string | null): DependencyChange {
  return {
    ecosystem: "javascript",
    manager: "npm",
    package: "x",
    from,
    to,
    kind: "runtime",
    directness: "direct",
    manifests: ["package.json"],
    lockfiles: ["package-lock.json"],
    protectedPaths: ["package.json", "package-lock.json"],
    capability: "repair-safe",
    evidence: [],
  };
}

test("update type is analysis policy, not version selection", () => {
  assert.equal(updateTypeFor(change("1.2.3", "2.0.0")), "major");
  assert.equal(updateTypeFor(change("1.2.3", "1.3.0")), "minor");
  assert.equal(updateTypeFor(change(null, "git:abc")), "unknown");
});

test("per-PR LLM limit deterministically bounds reviewer and fixer", () => {
  const parsed = parseConfig(`
version: 2
repair: {enabled: true, update_types: [major]}
verification: {commands: [npm test]}
report: {enabled: true, update_types: [major]}
cost: {max_dependencies_per_pr: 20, max_llm_calls_per_pr: 1}
`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(decidePolicy(parsed.config, [change("1.0.0", "2.0.0")]), {
    review: true,
    repair: false,
    overDependencyLimit: false,
    llmCalls: 1,
  });
});
