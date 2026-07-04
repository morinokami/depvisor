import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PmToolchain } from "./pm.ts";

export interface VerifyStep {
  name: string;
  /** Shell command, run via the system shell in the target repo. */
  run: string;
}

export interface VerifyResult {
  name: string;
  ok: boolean;
  code: number | null;
}

// Timeout keeps a hung test suite from eating the whole CI job.
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Parse explicitly configured verification commands: one shell command per
 * line, run in order. The value must come from the workflow
 * (`verify_commands` / DEPVISOR_VERIFY_COMMANDS), never from the agent-writable
 * working tree.
 */
export function parseVerifyCommands(raw: string): VerifyStep[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ name: line, run: line }));
}

/**
 * Derive the verification gate from package.json scripts in execution order
 * build → lint → test: build first because tests may consume its artifacts,
 * the expensive test suite last. Only scripts
 * the project actually defines are run; an empty result means the gate cannot
 * vouch for anything and the caller must not open a PR.
 */
export function verifyStepsFor(repoPath: string, pm: PmToolchain): VerifyStep[] {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }
  return ["build", "lint", "test"]
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => ({ name, run: pm.runScript(name) }));
}

/**
 * Run the verification gate. Steps run in order; the first failure stops the
 * gate. Output is inherited so failures can be diagnosed from the run log.
 */
export function runVerification(repoPath: string, steps: VerifyStep[]): VerifyResult[] {
  const results: VerifyResult[] = [];
  for (const step of steps) {
    const res = spawnSync(step.run, {
      cwd: repoPath,
      shell: true,
      stdio: "inherit",
      timeout: STEP_TIMEOUT_MS,
    });
    const ok = res.status === 0 && !res.error;
    results.push({ name: step.name, ok, code: res.status });
    if (!ok) break;
  }
  return results;
}
