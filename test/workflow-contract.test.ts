import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOutputsLine } from "../src/core/self-check.ts";

/**
 * The Action outputs cross several files that cannot import each other:
 * action.yml (the outputs block and its two inline fallback branches),
 * report-status.ts (the regular writer), the development workflow's outputs
 * echo, and the self-check regex that parses that echo back out of job logs.
 * These tests pin the copies to each other so a rename or reorder in one
 * place fails here instead of silently degrading a later run.
 */

const root = join(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function actionOutputKeys(action: string): string[] {
  const start = action.indexOf("\noutputs:");
  const end = action.indexOf("\nruns:");
  assert.ok(start !== -1 && end > start, "action.yml lost its outputs block");
  const section = action.slice(start, end);
  return [...section.matchAll(/^ {2}([a-z_]+):$/gm)].map((match) => match[1]!);
}

test("the development workflow's outputs echo stays parseable by the self-check", () => {
  const workflow = read(".github/workflows/depvisor.yml");
  const match = workflow.match(/run: echo "(status=[^"]+)"/);
  assert.ok(match, "depvisor.yml no longer contains the outputs echo line");
  const values: Record<string, string> = {
    STATUS: "reviewed",
    FAILED: "false",
    REPAIRED: "true",
    PR_URL: "https://github.com/octo/repo/pull/7",
    TOTAL_TOKENS: "1234",
    EST_COST_USD: "0.123456",
  };
  const line = match[1]!.replace(/\$([A-Z_]+)/g, (_span, name: string) => {
    const value = values[name];
    assert.ok(value !== undefined, `the outputs echo uses an unexpected variable $${name}`);
    return value;
  });
  assert.deepEqual(parseOutputsLine(`unrelated log line\n${line}\n`), {
    status: "reviewed",
    failed: false,
    repaired: true,
    totalTokens: 1234,
    estCostUsd: 0.123456,
  });
});

test("the three inline source-hash scripts in action.yml are byte-identical", () => {
  const action = read("action.yml");
  const scripts = [...action.matchAll(/-e '([^']+)'/g)].map((match) => match[1]!);
  assert.equal(scripts.length, 3, "expected exactly three inline hash scripts");
  assert.equal(scripts[1], scripts[0], "the publisher's hash script drifted");
  assert.equal(scripts[2], scripts[0], "the reporter's hash script drifted");
});

test("declared outputs, fallback echoes, and report-status writes stay in sync", () => {
  const action = read("action.yml");
  const declared = actionOutputKeys(action);
  assert.ok(declared.length >= 8, "action.yml declares fewer outputs than expected");

  const reportStatus = read("src/report-status.ts");
  const written = [...reportStatus.matchAll(/writeOutput\(\s*\n?\s*"([a-z_]+)"/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual([...written].toSorted(), [...declared].toSorted());

  for (const key of declared) {
    assert.ok(
      action.includes(`steps.report.outputs.${key}`),
      `output ${key} is not routed from the report step`,
    );
    const fallbackEchoes =
      action.match(new RegExp(`echo "${key}=[^"]*" >> "\\$GITHUB_OUTPUT"`, "g")) ?? [];
    assert.ok(
      fallbackEchoes.length >= 2,
      `output ${key} is missing from an inline fallback branch`,
    );
  }
});
