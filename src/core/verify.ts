import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PmToolchain } from "./pm.ts";
import { targetEnv } from "./target-env.ts";
import { tail } from "./text.ts";

export interface VerifyStep {
  name: string;
  /** Shell command, run via the system shell in the target repo. */
  run: string;
}

export interface VerifyResult {
  name: string;
  ok: boolean;
  code: number | null;
  /**
   * Bounded tail of the step's combined stdout+stderr, for INTERNAL use only:
   * the failure diagnostics the fixer prompt shows. Never written to the status
   * file or the PR payload — `stripVerifyTails` drops it at the record/payload
   * boundary so those shapes stay `{ name, ok, code }`.
   */
  tail?: string;
}

// Timeout keeps a hung test suite from eating the whole CI job.
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
// Generous capture ceiling: spawnSync's 1 MB default would kill a chatty but
// passing step, so raise it far past any realistic verify output. Output beyond
// this is truncated, not fatal.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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
 * gate. Output is captured (not inherited) so a failing step's tail can be
 * handed to the fixer, then echoed to the run log so failures stay diagnosable
 * there. Each result carries that bounded `tail`; callers strip it with
 * `stripVerifyTails` before it crosses the record/payload boundary.
 *
 * The child env is `targetEnv()`: verification commands run the target's own
 * scripts and test code — untrusted, and they must never see the LLM provider
 * key the agent step holds.
 */
export function runVerification(repoPath: string, steps: VerifyStep[]): VerifyResult[] {
  const results: VerifyResult[] = [];
  for (const step of steps) {
    const res = spawnSync(step.run, {
      cwd: repoPath,
      shell: true,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: targetEnv(),
    });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    const ok = res.status === 0 && !res.error;
    results.push({
      name: step.name,
      ok,
      code: res.status,
      tail: tail(`${res.stdout ?? ""}${res.stderr ?? ""}`),
    });
    if (!ok) break;
  }
  return results;
}

/**
 * Drop the internal `tail` from each result. Verification results are persisted
 * in the status file and rendered in the PR body as `{ name, ok, code }` only;
 * the tail exists solely to feed the fixer prompt, so it is stripped before a
 * result is recorded or handed to the PR payload.
 */
export function stripVerifyTails(results: readonly VerifyResult[]): VerifyResult[] {
  return results.map(({ name, ok, code }) => ({ name, ok, code }));
}
