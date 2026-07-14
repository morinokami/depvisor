/** Deterministic verification against commands read from the trusted base SHA. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, resetHardClean, snapshotWorktree, worktreeDrift } from "./git.ts";
import { RefGuard } from "./ref-guard.ts";
import { tail } from "./text.ts";
import type { VerificationStepResult } from "./types.ts";

export type VerificationPhase = "baseline" | "head" | "candidate";

export interface InternalVerificationResult extends VerificationStepResult {
  tail: string;
}

export interface VerificationRun {
  state: "green" | "stable-red" | "unstable" | "unexpected-commits" | "dirty";
  results: InternalVerificationResult[];
  detail: string;
}

const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function targetEnvironment(): { env: NodeJS.ProcessEnv; home: string } {
  const env: NodeJS.ProcessEnv = {};
  const safeExact = new Set([
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CI",
    "TERM",
    "JAVA_HOME",
    "GOROOT",
    "GOPATH",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "PNPM_HOME",
    "BUN_INSTALL",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (safeExact.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  const home = mkdtempSync(join(tmpdir(), "depvisor-target-home-"));
  const configHome = join(home, ".config");
  mkdirSync(configHome, { recursive: true });
  env.HOME = home;
  env.XDG_CONFIG_HOME = configHome;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.FORCE_COLOR = "0";
  return { env, home };
}

function runCommands(
  repo: string,
  phase: VerificationPhase,
  attempt: 1 | 2,
  prepare: readonly string[],
  commands: readonly string[],
): InternalVerificationResult[] {
  const results: InternalVerificationResult[] = [];
  const { env, home } = targetEnvironment();
  const steps = [
    ...prepare.map((run) => ({ name: `prepare: ${run}`, run, preparation: true })),
    ...commands.map((run) => ({ name: run, run, preparation: false })),
  ];
  let preparationFailed = false;
  try {
    for (const step of steps) {
      if (preparationFailed && !step.preparation) break;
      const result = spawnSync(step.run, {
        cwd: repo,
        shell: true,
        encoding: "utf8",
        timeout: STEP_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      const ok = result.status === 0 && !result.error;
      results.push({
        phase,
        attempt,
        name: step.name,
        ok,
        code: result.status,
        tail: tail(`${result.stdout ?? ""}${result.stderr ?? ""}`),
      });
      if (!ok && step.preparation) preparationFailed = true;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return results;
}

function green(results: readonly InternalVerificationResult[]): boolean {
  return results.length > 0 && results.every((result) => result.ok);
}

function signature(results: readonly InternalVerificationResult[]): string {
  return results.map((result) => `${result.name}:${result.ok}:${result.code}`).join("|");
}

export function runConfirmedVerification(
  repo: string,
  sha: string,
  phase: "baseline" | "head",
  prepare: readonly string[],
  commands: readonly string[],
): VerificationRun {
  if (commands.length === 0) {
    return { state: "stable-red", results: [], detail: "No verification commands are configured." };
  }
  resetHardClean(repo, sha);
  const guard = RefGuard.capture(repo);
  const first = runCommands(repo, phase, 1, prepare, commands);
  const firstDrift = guard.intactAt(sha, sha);
  if (firstDrift) {
    return {
      state: "unexpected-commits",
      results: first,
      detail: `Target execution moved git state: ${firstDrift.refs.join(", ") || "HEAD"}.`,
    };
  }
  if (changedPaths(repo).length > 0) {
    return { state: "dirty", results: first, detail: "Verification modified the repository." };
  }
  if (green(first)) return { state: "green", results: first, detail: "Verification passed." };

  resetHardClean(repo, sha);
  const second = runCommands(repo, phase, 2, prepare, commands);
  const secondDrift = guard.intactAt(sha, sha);
  if (secondDrift) {
    return {
      state: "unexpected-commits",
      results: [...first, ...second],
      detail: `Confirmation moved git state: ${secondDrift.refs.join(", ") || "HEAD"}.`,
    };
  }
  if (changedPaths(repo).length > 0) {
    return {
      state: "dirty",
      results: [...first, ...second],
      detail: "Confirmation modified the repository.",
    };
  }
  if (signature(first) !== signature(second)) {
    return {
      state: "unstable",
      results: [...first, ...second],
      detail: "Clean verification attempts disagreed.",
    };
  }
  return {
    state: "stable-red",
    results: [...first, ...second],
    detail: "The same verification failure reproduced twice.",
  };
}

export function runCandidateVerification(
  repo: string,
  updaterHeadSha: string,
  prepare: readonly string[],
  commands: readonly string[],
): VerificationRun {
  const guard = RefGuard.capture(repo);
  const expectedWorktree = snapshotWorktree(repo);
  const results = runCommands(repo, "candidate", 1, prepare, commands);
  const refMovement = guard.intactAt(updaterHeadSha, updaterHeadSha);
  if (refMovement) {
    return {
      state: "unexpected-commits",
      results,
      detail: `Candidate verification moved git state: ${refMovement.refs.join(", ") || "HEAD"}.`,
    };
  }
  const drift = worktreeDrift(repo, expectedWorktree);
  if (drift.length > 0) {
    return {
      state: "dirty",
      results,
      detail: `Candidate verification changed the serialized fixer patch: ${drift.join(", ")}.`,
    };
  }
  return green(results)
    ? { state: "green", results, detail: "Candidate verification passed." }
    : { state: "stable-red", results, detail: "The one-shot candidate did not pass." };
}

export function publicVerificationResults(
  results: readonly InternalVerificationResult[],
): VerificationStepResult[] {
  return results.map(({ phase, attempt, name, ok, code }) => ({ phase, attempt, name, ok, code }));
}
