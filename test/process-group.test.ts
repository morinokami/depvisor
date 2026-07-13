import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

const bumpScript =
  "const fs=require('node:fs');" +
  "const p=JSON.parse(fs.readFileSync('package.json','utf8'));" +
  "p.dependencies['left-pad']='^1.1.0';" +
  "fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\\n');";

const bumpingPm: PmToolchain = {
  ...noChangePm,
  updatePlan: (_candidates, _repo, opts) => ({
    catalogEdits: [],
    commands: [[process.execPath, "-e", bumpScript]],
    pinExact: opts?.pinExact ?? false,
  }),
};

const harness = {} as ProcessGroupOptions["harness"];
const log = {
  info() {},
  warn() {},
} as unknown as ProcessGroupOptions["log"];

function digestHarness(repo: string, dirtyDuringDigest = false): ProcessGroupOptions["harness"] {
  return {
    async session() {
      return {
        async task() {
          if (dirtyDuringDigest) {
            // Simulates a delayed child from earlier target code. The real
            // digest has no host write bridge, but the seal must still restore
            // tree-only drift when refs and HEAD remain intact.
            writeFileSync(join(repo, "digest-leftover.txt"), "late write\n");
          }
          return {
            data: {
              summary: "digest-only-summary",
              upstream_changes: [],
              review_notes: [],
            },
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { total: 0.001 },
            },
            model: { provider: "test", id: "digest" },
          };
        },
      };
    },
  } as unknown as ProcessGroupOptions["harness"];
}

function fixerHarness(repo: string, writesFix = true): ProcessGroupOptions["harness"] {
  return {
    async session() {
      return {
        async task(_prompt: string, taskOptions: { agent: string }) {
          const usage = {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { total: 0.001 },
          };
          if (taskOptions.agent === "fixer") {
            if (writesFix) writeFileSync(join(repo, "src.ts"), "export const fixed = true;\n");
            return {
              data: {
                summary: "Adapted source for the new dependency.",
                fixes_applied: ["updated the compatibility shim"],
                residual_risks: [],
                verdict: "fixed",
              },
              usage,
              model: { provider: "test", id: "fixer" },
            };
          }
          return {
            data: {
              summary: "digest-after-fix",
              upstream_changes: [],
              review_notes: [],
            },
            usage,
            model: { provider: "test", id: "digest" },
          };
        },
      };
    },
  } as unknown as ProcessGroupOptions["harness"];
}

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
    language: "",
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
  assert.equal("requiresResetNext" in outcome, false);
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

function preparedOptions(repo: string, dirtyDuringDigest = false): ProcessGroupOptions {
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { "left-pad": "^1.0.0" } }, null, 2) + "\n",
  );
  execSync("git add package.json && git commit -qm 'add dependency'", {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const opts = options(repo);
  opts.pm = bumpingPm;
  opts.harness = digestHarness(repo, dirtyDuringDigest);
  // A present packument with no GitHub repository makes digestNotes return its
  // deterministic unavailable note without any network lookup.
  opts.packuments.set("left-pad", {
    repository: null,
    versions: {
      "1.0.0": { license: "MIT" },
      "1.1.0": { license: "MIT" },
    },
  });
  return opts;
}

test("the fast path returns a sealed prepared payload and consumes a new-PR slot", async () => {
  const repo = tempRepo();
  const outcome = await processGroup(preparedOptions(repo));

  assert.equal(outcome.kind, "prepared");
  if (outcome.kind !== "prepared") return;
  assert.equal(outcome.result.status, "pr-prepared");
  assert.equal(
    outcome.result.verification.every((step) => step.ok),
    true,
  );
  assert.equal(outcome.consumedSlot, true);
  assert.equal(outcome.requiresResetNext, true);
  assert.match(outcome.payload.body, /digest-only-summary/);
  assert.ok(outcome.payload.labels.includes("fixer:none"));
  assert.ok(!outcome.payload.labels.includes("fixer:applied"));
  // The trusted advisory lookup in these options succeeded (ok: true), so the
  // open-pr step is allowed to reconcile `security` away on refresh.
  assert.equal(outcome.payload.advisoriesOk, true);
  assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("the digest seal restores tree-only drift and discards the display report", async () => {
  const repo = tempRepo();
  const outcome = await processGroup(preparedOptions(repo, true));

  assert.equal(outcome.kind, "prepared");
  if (outcome.kind !== "prepared") return;
  assert.equal(existsSync(join(repo, "digest-leftover.txt")), false);
  assert.doesNotMatch(outcome.payload.body, /digest-only-summary/);
  assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("a validated fixer commit produces fixer:applied provenance", async () => {
  const repo = tempRepo();
  const opts = preparedOptions(repo);
  const gateScript =
    "const fs=require('node:fs');" +
    "const p=JSON.parse(fs.readFileSync('package.json','utf8'));" +
    "const source=fs.existsSync('src.ts')?fs.readFileSync('src.ts','utf8'):'';" +
    "process.exit(p.dependencies['left-pad']==='^1.1.0'&&!source.includes('fixed')?1:0);";
  opts.verifySteps = [
    {
      name: "compatibility",
      run: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(gateScript)}`,
    },
  ];
  opts.harness = fixerHarness(repo);

  const outcome = await processGroup(opts);

  assert.equal(outcome.kind, "prepared");
  if (outcome.kind !== "prepared") return;
  assert.ok(outcome.payload.labels.includes("fixer:applied"));
  assert.ok(!outcome.payload.labels.includes("fixer:none"));
  // With an accepted fix commit, the fixer's account of it belongs in the body.
  assert.match(outcome.payload.body, /updated the compatibility shim/);
  assert.equal(
    execSync("git rev-list --count main..HEAD", { cwd: repo, encoding: "utf8" }).trim(),
    "2",
  );
  assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim(), "");
});

test("an invoked fixer with no accepted commit remains fixer:none", async () => {
  const repo = tempRepo();
  const opts = preparedOptions(repo);
  const counter = join(mkdtempSync(join(tmpdir(), "depvisor-verify-counter-")), "count");
  writeFileSync(counter, "0");
  const gateScript =
    "const fs=require('node:fs');" +
    `const path=${JSON.stringify(counter)};` +
    "const count=Number(fs.readFileSync(path,'utf8'))+1;" +
    "fs.writeFileSync(path,String(count));" +
    "process.exit(count===2?1:0);";
  opts.verifySteps = [
    {
      name: "transient compatibility",
      run: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(gateScript)}`,
    },
  ];
  opts.harness = fixerHarness(repo, false);

  const outcome = await processGroup(opts);

  assert.equal(outcome.kind, "prepared");
  if (outcome.kind !== "prepared") return;
  assert.ok(outcome.payload.labels.includes("fixer:none"));
  assert.ok(!outcome.payload.labels.includes("fixer:applied"));
  // No accepted commit → the agent's claimed fixes must not reach the body of a
  // PR that carries no fix commit.
  assert.doesNotMatch(outcome.payload.body, /updated the compatibility shim/);
  assert.equal(
    execSync("git rev-list --count main..HEAD", { cwd: repo, encoding: "utf8" }).trim(),
    "1",
  );
  assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim(), "");
});
