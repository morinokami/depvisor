/** Git leaves used by immutable-head analysis, verification, and publication. */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";

export const AGENT_NAME = "depvisor";
export const AGENT_EMAIL = "depvisor[bot]@users.noreply.github.com";
export const AGENT_AUTHOR =
  "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";

export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;
const GIT_BINARY = "/usr/bin/git";

export interface GitResult {
  code: number;
  out: string;
  err: string;
}

export function runGit(
  repo: string,
  args: readonly string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): GitResult {
  const result = spawnSync(GIT_BINARY, [...NO_HOOKS, ...args], {
    cwd: repo,
    encoding: "utf8",
    input: options.input,
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    out: result.stdout ?? "",
    err: (result.stderr ?? "").trim(),
  };
}

function git(repo: string, args: readonly string[], input?: string): string {
  const result = runGit(repo, args, input === undefined ? {} : { input });
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.code}): ${result.err || result.out.trim()}`,
    );
  }
  return result.out.trim();
}

export function revParse(repo: string, ref: string): string {
  return git(repo, ["rev-parse", "--verify", ref]);
}

export function mergeBase(repo: string, base: string, head: string): string {
  return git(repo, ["merge-base", base, head]);
}

export function fileAtRef(repo: string, ref: string, path: string): string | null {
  const result = runGit(repo, ["show", `${ref}:${path}`]);
  return result.code === 0 ? result.out : null;
}

function nulPaths(result: GitResult, description: string): string[] {
  if (result.code !== 0) throw new Error(`${description} failed: ${result.err}`);
  return result.out.split("\0").filter(Boolean).toSorted();
}

export function diffPaths(repo: string, from: string, to: string): string[] {
  return nulPaths(
    runGit(repo, ["diff", "--name-only", "--no-renames", "-z", from, to]),
    `git diff ${from} ${to}`,
  );
}

export function changedPaths(repo: string): string[] {
  const result = runGit(repo, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (result.code !== 0) throw new Error(`git status failed: ${result.err}`);
  const tokens = result.out.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const original = tokens[index + 1];
      if (original) paths.push(original);
      index += 1;
    }
  }
  return paths.toSorted();
}

export function resetHardClean(repo: string, sha: string): void {
  git(repo, ["checkout", "--detach", "-f", sha]);
  git(repo, ["reset", "--hard", sha]);
  git(repo, ["clean", "-ffdx"]);
}

export function snapshotRefs(repo: string): Map<string, string> {
  const refs = new Map<string, string>();
  const output = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  for (const line of output.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator > 0) refs.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return refs;
}

export function refDrift(repo: string, expected: ReadonlyMap<string, string>): string[] {
  const current = snapshotRefs(repo);
  const drift = new Set<string>();
  for (const [ref, sha] of expected) if (current.get(ref) !== sha) drift.add(ref);
  for (const ref of current.keys()) if (!expected.has(ref)) drift.add(ref);
  return [...drift].toSorted();
}

export function restoreRefs(
  repo: string,
  expected: ReadonlyMap<string, string>,
  checkoutRef: string,
): void {
  for (const [ref, sha] of expected) git(repo, ["update-ref", ref, sha]);
  git(repo, ["checkout", "--detach", "-f", checkoutRef]);
  for (const ref of snapshotRefs(repo).keys()) {
    if (!expected.has(ref)) git(repo, ["update-ref", "-d", ref]);
  }
  git(repo, ["clean", "-fd"]);
}

export type WorktreeSnapshot = Map<string, string>;

function fingerprint(repo: string, path: string): string {
  const full = join(repo, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) return `link:${stat.mode}:${readlinkSync(full)}`;
  if (!stat.isFile()) return `other:${stat.mode}:${stat.size}`;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(full, "r");
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return `file:${stat.mode}:${stat.size}:${hash.digest("hex")}`;
}

export function snapshotWorktree(repo: string): WorktreeSnapshot {
  return new Map(changedPaths(repo).map((path) => [path, fingerprint(repo, path)]));
}

export function worktreeDrift(repo: string, expected: ReadonlyMap<string, string>): string[] {
  const current = snapshotWorktree(repo);
  const drift = new Set<string>();
  for (const [path, value] of expected) if (current.get(path) !== value) drift.add(path);
  for (const path of current.keys()) if (!expected.has(path)) drift.add(path);
  return [...drift].toSorted();
}

export function createPatch(repo: string, updaterHeadSha: string): string {
  const result = runGit(repo, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    updaterHeadSha,
  ]);
  if (result.code !== 0) throw new Error(`could not serialize candidate patch: ${result.err}`);
  return result.out;
}

export function applyPatch(repo: string, patch: string): void {
  const result = runGit(repo, ["apply", "--whitespace=nowarn", "-"], { input: patch });
  if (result.code !== 0) throw new Error(`candidate patch did not apply: ${result.err}`);
}

export function patchHash(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

export function repairCommitMessage(updaterHeadSha: string, suffix: string): string {
  return `fix(deps): adapt to dependency update\n\nDepvisor-Updater-Head: ${updaterHeadSha}${suffix}`;
}
