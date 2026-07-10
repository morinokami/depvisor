import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PmToolchain } from "../src/core/pm.ts";
import type { Candidate, Group } from "../src/core/types.ts";
import { processGroup, type ProcessGroupOptions } from "../src/workflows/update/process-group.ts";

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-process-group-"));
  execSync("git init -q -b main", { cwd: repo });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture"}\n');
  execSync("git add -A", { cwd: repo });
  execSync("git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });
  return repo;
}

const candidate: Candidate = {
  name: "left-pad",
  current: "1.0.0",
  latest: "1.1.0",
  kind: "prod",
  updateType: "minor",
  locations: [""],
};

const group: Group = {
  key: "prod/left-pad",
  reason: "test",
  members: [candidate],
};

const noChangePm: PmToolchain = {
  name: "npm",
  outdatedArgv: ["npm", "outdated"],
  runScript: (script) => `npm run ${script}`,
  updatePlan: (_candidates, _repo, opts) => ({
    catalogEdits: [],
    commands: [],
    pinExact: opts?.pinExact ?? false,
  }),
  lockfiles: ["package-lock.json"],
  extraBumpFiles: [],
  noLockfileInstall: "npm install --no-package-lock",
  installCommand: () => null,
};

const harness = {} as ProcessGroupOptions["harness"];
const log = {
  info() {},
  warn() {},
} as unknown as ProcessGroupOptions["log"];

function options(repo: string): ProcessGroupOptions {
  return {
    repo,
    group,
    branch: "depvisor/prod-left-pad",
    base: "main",
    verifySteps: [{ name: "baseline", run: "true" }],
    pm: noChangePm,
    resetCommand: null,
    requiresResetBefore: false,
    minimumReleaseAge: 1,
    suggestFeatures: false,
    disposition: "open-new",
    packuments: new Map(),
    advisories: { ok: true, resolvedByPackage: new Map() },
    harness,
    log,
  };
}

test("a first-group baseline failure stops the run without requiring a reset", async () => {
  const repo = tempRepo();
  const opts = options(repo);
  opts.verifySteps = [{ name: "red", run: "false" }];

  const outcome = await processGroup(opts);
  assert.equal(outcome.kind, "stop");
  assert.equal(outcome.kind === "stop" ? outcome.status : null, "baseline-red");
  assert.equal(outcome.requiresResetNext, false);
});

test("an unavailable between-group reinstall records the group and keeps reset state", async () => {
  const repo = tempRepo();
  const opts = options(repo);
  opts.requiresResetBefore = true;

  const outcome = await processGroup(opts);
  assert.equal(outcome.kind, "recorded");
  assert.equal(outcome.kind === "recorded" ? outcome.result.status : null, "reinstall-unavailable");
  assert.equal(outcome.requiresResetNext, true);
});

test("crossing the baseline boundary requires later groups to reset even on no-changes", async () => {
  const repo = tempRepo();
  const outcome = await processGroup(options(repo));

  assert.equal(outcome.kind, "recorded");
  assert.equal(outcome.kind === "recorded" ? outcome.result.status : null, "no-changes");
  assert.equal(outcome.requiresResetNext, true);
});
