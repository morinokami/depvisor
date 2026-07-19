/**
 * Minimal git leaves used by v2's snapshot and fix handoff.
 *
 * check-credentials.ts loads this module (through credentials.ts) BEFORE
 * `pnpm install`, so it must import only node: builtins and relative modules
 * — never an installable package. The fix-payload types are therefore
 * imported type-only from fix-payload.ts (erased at runtime), which owns
 * the valibot schemas; test/workflow-contract.test.ts pins this closure.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isSafeRepoPath } from "./paths.ts";
import type { NewFixFile, FixChanges } from "./fix-payload.ts";

export type { NewFixFile, FixChanges };

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;
export const MAX_FIX_FILES = 200;
const MAX_FIX_BYTES = 5 * 1024 * 1024;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(repo: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", [...NO_HOOKS, "-c", "core.pager=cat", ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(repo: string, args: readonly string[]): string {
  const result = run(repo, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

function nulList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export function isRepoRoot(repo: string): boolean {
  const result = run(repo, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return false;
  try {
    return realpathSync(result.stdout.trim()) === realpathSync(repo);
  } catch {
    return false;
  }
}

export function headSha(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function isClean(repo: string): boolean {
  return git(repo, ["status", "--porcelain=v1", "-z"]) === "";
}

/**
 * Enumerate the blob paths of one commit with a single read-only git call so
 * per-path existence checks never spawn a process. A failed enumeration
 * returns an empty set instead of throwing; membership checks then fail soft.
 */
export function treeBlobPaths(repo: string, ref: string): Set<string> {
  const paths = new Set<string>();
  const result = run(repo, ["ls-tree", "-r", "-z", ref]);
  if (result.code !== 0) return paths;
  for (const entry of result.stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    if (entry.slice(0, tab).split(" ")[1] === "blob") paths.add(entry.slice(tab + 1));
  }
  return paths;
}

/** Compare the fix handoff by value, never by JavaScript object insertion order. */
export function sameFixChanges(left: FixChanges, right: FixChanges): boolean {
  if (left.patch !== right.patch || left.paths.length !== right.paths.length) return false;
  if (left.paths.some((path, index) => path !== right.paths[index])) return false;
  if (left.newFiles.length !== right.newFiles.length) return false;
  return left.newFiles.every((file, index) => {
    const other = right.newFiles[index];
    return (
      other !== undefined &&
      file.path === other.path &&
      file.contentBase64 === other.contentBase64 &&
      file.executable === other.executable &&
      file.symlink === other.symlink
    );
  });
}

/** Git already emits repository-relative paths; hold them to the one shared rule set. */
function safeRelativePath(path: string): string {
  if (!isSafeRepoPath(path)) throw new Error(`Unsafe fix path: ${path}`);
  return path;
}

/** Capture exactly what the agent changed without trusting a commit it made. */
export function captureFixChanges(repo: string): FixChanges {
  const patch = git(repo, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const tracked = nulList(git(repo, ["diff", "--name-only", "-z", "HEAD", "--"]));
  const untracked = nulList(git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--"]));
  const newFiles = untracked.map((rawPath) => {
    const path = safeRelativePath(rawPath);
    const absolute = resolve(repo, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`The fix added an unsupported filesystem entry: ${path}`);
    }
    const content = stat.isSymbolicLink()
      ? Buffer.from(readlinkSync(absolute))
      : readFileSync(absolute);
    return {
      path,
      contentBase64: content.toString("base64"),
      executable: (stat.mode & 0o111) !== 0,
      symlink: stat.isSymbolicLink(),
    };
  });
  const paths = [...new Set([...tracked, ...untracked].map(safeRelativePath))].toSorted();
  const totalBytes =
    Buffer.byteLength(patch) +
    newFiles.reduce((sum, file) => sum + Buffer.from(file.contentBase64, "base64").byteLength, 0);
  if (paths.length > MAX_FIX_FILES || totalBytes > MAX_FIX_BYTES) {
    throw new Error(
      `The fix exceeds the publication limit (${paths.length}/${MAX_FIX_FILES} files, ${totalBytes}/${MAX_FIX_BYTES} bytes)`,
    );
  }
  return {
    patch,
    newFiles,
    paths,
  };
}

/** Repo-local config only; values can contain credentials and must never be logged. */
export function localConfigEntries(
  repo: string,
  keyPattern: string,
): { key: string; value: string }[] {
  const result = run(repo, ["config", "--local", "--includes", "-z", "--get-regexp", keyPattern]);
  if (result.code !== 0) return [];
  return result.stdout.split("\0").flatMap((chunk) => {
    if (!chunk) return [];
    const newline = chunk.indexOf("\n");
    return [
      newline === -1
        ? { key: chunk, value: "" }
        : { key: chunk.slice(0, newline), value: chunk.slice(newline + 1) },
    ];
  });
}
