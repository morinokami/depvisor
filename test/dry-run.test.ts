import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dryRunPlanPath,
  emitDryRunPlan,
  parseDryRun,
  planDryRunGroups,
  readDryRunPlan,
  renderDryRunPlan,
  summarizeDryRunGroups,
  type DryRunPlan,
} from "../src/core/dry-run.ts";
import { versionsMarker } from "../src/core/pr.ts";
import type { OpenPrMetadata } from "../src/core/open-pr-snapshot.ts";
import { emitRunStatus } from "../src/core/status.ts";
import type { Candidate, Group } from "../src/core/types.ts";

function candidate(name: string): Candidate {
  return {
    name,
    current: "1.0.0",
    latest: "2.0.0",
    kind: "prod",
    updateType: "major",
    locations: [""],
  };
}

function group(key: string, name = key.split("/").at(-1) ?? key): Group {
  return { key, reason: "test", members: [candidate(name)] };
}

const metadata = (headRefName: string, body: string, conflicted = false): OpenPrMetadata => ({
  number: 1,
  headRefName,
  body,
  conflicted,
  mergeabilityUnknown: false,
  mergeabilityObserved: true,
});

test("parseDryRun follows the boolean input convention and fails closed", () => {
  for (const raw of ["", " ", "false", " false "]) assert.equal(parseDryRun(raw), false);
  for (const raw of ["true", " true "]) assert.equal(parseDryRun(raw), true);
  for (const raw of ["yes", "TRUE", "0", "false-ish"]) assert.equal(parseDryRun(raw), null);
});

test("dry-run planning fixes existing-PR outcomes and projects new slots optimistically", () => {
  const groups = [
    group("dev/a", "a"),
    group("dev/b", "b"),
    group("prod/c", "c"),
    group("prod/d", "d"),
    group("prod/@babel/core", "@babel/core"),
    group("prod/babel-core", "babel-core"),
  ];
  const open = new Map([
    ["depvisor/dev-a", metadata("depvisor/dev-a", `body\n${versionsMarker(groups[0]!.members)}`)],
    ["depvisor/dev-b", metadata("depvisor/dev-b", "body with no current trailing marker")],
  ]);
  const planned = planDryRunGroups(groups, open, 1);
  assert.deepEqual(
    planned.map((p) => p.disposition),
    [
      "skip-up-to-date",
      "refresh",
      "open-new-provisional",
      "held-back-provisional",
      "held-back-provisional",
      "branch-collision",
    ],
  );
  assert.equal(planned[4]?.branch, planned[5]?.branch);
  assert.equal(
    summarizeDryRunGroups(planned),
    "Planned 6 group(s): 1 refresh, 1 skip-up-to-date, 1 open-new (provisional), 2 held-back (provisional), 1 branch-collision.",
  );
});

test("dry-run planning refreshes an unchanged conflicted PR with a base-conflict reason", () => {
  const groups = [group("prod/a", "a")];
  const branch = "depvisor/prod-a";
  const open: OpenPrMetadata = {
    number: 1,
    headRefName: branch,
    body: `body\n${versionsMarker(groups[0]!.members)}`,
    conflicted: true,
    mergeabilityUnknown: false,
    mergeabilityObserved: true,
  };
  const planned = planDryRunGroups(groups, new Map([[branch, open]]), 0);
  assert.equal(planned[0]?.disposition, "refresh");
  assert.equal(planned[0]?.refreshReason, "base-conflict");
});

test("conflict-only dry-run never gives a new group a provisional disposition", () => {
  const groups = [group("prod/b", "b"), group("prod/c", "c")];
  const branch = "depvisor/prod-b";
  const open: OpenPrMetadata = {
    number: 2,
    headRefName: branch,
    body: "stale marker",
    conflicted: true,
    mergeabilityUnknown: false,
    mergeabilityObserved: true,
  };
  const planned = planDryRunGroups(groups, new Map([[branch, open]]), 5, true);
  assert.deepEqual(
    planned.map((entry) => [entry.branch, entry.disposition, entry.refreshReason]),
    [[branch, "refresh", "base-conflict"]],
  );
});

function plan(): DryRunPlan {
  const pkg = {
    name: "@scope/pkg",
    current: "1.0.0",
    latest: "2.0.0",
    kind: "prod" as const,
    updateType: "major" as const,
  };
  return {
    mode: "normal",
    suppressedGroupCount: 0,
    collected: [pkg],
    ignored: [],
    cooldown: {
      minimumReleaseAge: 1,
      clamped: [{ name: "@scope/pkg", from: "2.0.0", to: "1.9.0" }],
      excluded: [],
      heldBack: [],
      unavailable: [],
    },
    groups: [
      {
        key: "major/@scope/pkg",
        branch: "depvisor/major-scope-pkg",
        packages: [{ ...pkg, latest: "1.9.0", updateType: "minor" }],
        disposition: "open-new-provisional",
      },
    ],
    budget: { openPullRequestsLimit: 5, openDepvisorPrCount: 1, initialNewSlots: 4 },
    notes: {
      ignore: "",
      releaseAge: "minimum_release_age=1: clamped @scope/pkg.",
      advisories: "",
    },
  };
}

test("dry-run plan round-trips through the validated file and renders its assumptions", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-dry-run-"));
  const file = emitDryRunPlan(dir, plan());
  assert.equal(file, dryRunPlanPath(dir));
  const parsed = readDryRunPlan(file);
  assert.deepEqual(parsed, plan());
  const summary = renderDryRunPlan(parsed);
  assert.match(summary, /Dry-run plan/);
  assert.match(summary, /open-new-provisional/);
  assert.match(summary, /assume every earlier/);
  assert.match(summary, /clamped/);
});

test("dry-run plan read-back rejects corrupt and wrong-shaped files", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-dry-run-"));
  const file = dryRunPlanPath(dir);
  writeFileSync(file, "{broken");
  assert.equal(readDryRunPlan(file), null);
  writeFileSync(file, JSON.stringify({ groups: [] }));
  assert.equal(readDryRunPlan(file), null);
});

test("report-status renders a validated dry-run plan and keeps zero-work outputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-dry-run-report-"));
  const summary = join(dir, "summary.md");
  const output = join(dir, "output.txt");
  emitDryRunPlan(dir, plan());
  const status = emitRunStatus(dir, {
    status: "dry-run-completed",
    base: "main",
    summary: "Planned one group.",
    groups: [],
  });
  const result = spawnSync(process.execPath, ["src/report-status.ts", status], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(summary, "utf8"), /Dry-run plan/);
  const outputs = readFileSync(output, "utf8");
  assert.match(outputs, /dry-run-completed/);
  assert.match(outputs, /prepared_count[^\n]*\n0\n/);
  assert.match(outputs, /total_tokens[^\n]*\n0\n/);
});

test("report-status fails closed when dry-run-completed has no readable plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-dry-run-report-"));
  const output = join(dir, "output.txt");
  const status = emitRunStatus(dir, {
    status: "dry-run-completed",
    base: "main",
    summary: "Plan missing.",
    groups: [],
  });
  const result = spawnSync(process.execPath, ["src/report-status.ts", status], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /without emitting its plan/);
  assert.match(readFileSync(output, "utf8"), /failed[^\n]*\ntrue\n/);
});
