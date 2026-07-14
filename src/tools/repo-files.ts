import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { REPO } from "../shared/target.ts";

/**
 * Bounded repository tools for the two agent profiles.
 *
 * The root agent uses Flue's in-memory virtual sandbox, not `local()`, so its
 * built-in filesystem/shell capabilities cannot reach the runner. These custom
 * tools are the only bridge to the host checkout: reviewer receives the read-only
 * set, while fixer additionally receives the write set. Every path is repo-
 * relative, jailed below the real target root (including symlink resolution),
 * and `.git` is never exposed. A prompt-injected agent therefore cannot rewrite
 * depvisor's own checkout or the later token-holding publisher entrypoint.
 */

const READ_CHARS_MAX = 30_000;
const READ_LINES_MAX = 400;
const READ_FILE_BYTES_MAX = 1024 * 1024;
const SEARCH_CHARS_MAX = 30_000;
const LIST_FILES_MAX = 1_000;
const SEARCH_FILES_MAX = 10_000;
const SEARCH_FILE_BYTES_MAX = 1024 * 1024;
const SEARCH_MATCHES_MAX = 200;
const WRITE_CHARS_MAX = 500_000;

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function repoRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

function assertNotGit(root: string, path: string): void {
  const git = resolve(root, ".git");
  if (path === git || path.startsWith(`${git}${sep}`)) {
    throw new Error(".git is outside the agent-visible repository surface");
  }
}

function lexicalPath(repo: string, raw: string): { root: string; abs: string; rel: string } {
  if (!raw || raw.includes("\0") || isAbsolute(raw)) {
    throw new Error("path must be a non-empty repository-relative path");
  }
  const root = realpathSync(repo);
  const abs = resolve(root, normalize(raw));
  if (!isInside(root, abs)) throw new Error("path escapes the repository root");
  const rel = repoRelative(root, abs);
  if (rel === ".git" || rel.startsWith(".git/")) {
    throw new Error(".git is outside the agent-visible repository surface");
  }
  return { root, abs, rel };
}

/** Resolve an existing path and reject a symlink whose target escapes `repo`. */
function existingPath(repo: string, raw: string): { abs: string; rel: string } {
  const path = lexicalPath(repo, raw);
  const real = realpathSync(path.abs);
  if (!isInside(path.root, real)) throw new Error("path resolves outside the repository root");
  assertNotGit(path.root, real);
  return { abs: real, rel: repoRelative(path.root, real) };
}

/**
 * Resolve a write target. For a new file, validate its closest existing parent;
 * for an existing file, validate the file itself. This closes the ordinary
 * symlink escape (`repo/link -> action checkout`) as well as lexical `../`.
 */
function writablePath(repo: string, raw: string): { abs: string; rel: string } {
  const path = lexicalPath(repo, raw);
  if (existsSync(path.abs)) {
    const real = realpathSync(path.abs);
    if (!isInside(path.root, real)) throw new Error("path resolves outside the repository root");
    assertNotGit(path.root, real);
    return { abs: real, rel: repoRelative(path.root, real) };
  }
  let parent = dirname(path.abs);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error("cannot resolve a parent inside the repository");
    parent = next;
  }
  const realParent = realpathSync(parent);
  if (!isInside(path.root, realParent)) {
    throw new Error("path parent resolves outside the repository root");
  }
  assertNotGit(path.root, realParent);
  return { abs: path.abs, rel: path.rel };
}

function cap(value: string, max: number): { text: string; truncated: boolean } {
  return value.length <= max
    ? { text: value, truncated: false }
    : { text: value.slice(0, max), truncated: true };
}

function assertReadableFile(path: string, maxBytes: number): void {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("path must resolve to a regular file");
  if (stat.size > maxBytes) {
    throw new Error(`file exceeds the ${maxBytes}-byte tool limit`);
  }
}

export function readRepoFile(
  repo: string,
  path: string,
  startLine = 1,
  endLine = startLine + READ_LINES_MAX - 1,
): { path: string; content: string; truncated: boolean } {
  const resolved = existingPath(repo, path);
  assertReadableFile(resolved.abs, READ_FILE_BYTES_MAX);
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.max(start, Math.min(Math.floor(endLine), start + READ_LINES_MAX - 1));
  const lines = readFileSync(resolved.abs, "utf8").split(/\r?\n/);
  const selected = lines.slice(start - 1, end).join("\n");
  const bounded = cap(selected, READ_CHARS_MAX);
  return {
    path: resolved.rel,
    content: bounded.text,
    truncated: bounded.truncated || end < lines.length,
  };
}

export function listRepoFiles(repo: string, path = "."): { files: string[]; truncated: boolean } {
  const resolved = existingPath(repo, path);
  const files = collectRepoFiles(resolved.abs, resolved.rel, LIST_FILES_MAX + 1);
  return { files: files.slice(0, LIST_FILES_MAX), truncated: files.length > LIST_FILES_MAX };
}

function collectRepoFiles(abs: string, rel: string, max: number): string[] {
  const stat = lstatSync(abs);
  if (stat.isFile()) return [rel];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (files.length >= max) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      // Do not let traversal acquire a second path/identity through a symlink.
      // Direct reads still allow an in-repo symlink after realpath validation.
      if (entry.isSymbolicLink()) continue;
      const childAbs = join(dir, entry.name);
      const childRel = prefix === "." ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  walk(abs, rel);
  return files;
}

export function searchRepo(
  repo: string,
  query: string,
  path = ".",
): { output: string; truncated: boolean } {
  if (!query) throw new Error("query must not be empty");
  const resolved = existingPath(repo, path);
  const files = collectRepoFiles(resolved.abs, resolved.rel, SEARCH_FILES_MAX + 1);
  const matches: string[] = [];
  let truncated = files.length > SEARCH_FILES_MAX;
  const root = realpathSync(repo);
  for (const file of files.slice(0, SEARCH_FILES_MAX)) {
    const full = resolve(root, file);
    const stat = lstatSync(full);
    if (stat.size > SEARCH_FILE_BYTES_MAX) continue;
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]?.includes(query)) continue;
      matches.push(`${file}:${i + 1}:${(lines[i] ?? "").slice(0, 500)}`);
      if (matches.length >= SEARCH_MATCHES_MAX) {
        truncated = true;
        break;
      }
    }
    if (matches.length >= SEARCH_MATCHES_MAX) break;
  }
  const bounded = cap(matches.join("\n"), SEARCH_CHARS_MAX);
  return { output: bounded.text, truncated: truncated || bounded.truncated };
}

export function writeRepoFile(repo: string, path: string, content: string): { path: string } {
  if (content.length > WRITE_CHARS_MAX) {
    throw new Error(`content exceeds the ${WRITE_CHARS_MAX}-character tool limit`);
  }
  const resolved = writablePath(repo, path);
  mkdirSync(dirname(resolved.abs), { recursive: true });
  writeFileSync(resolved.abs, content);
  return { path: resolved.rel };
}

export function replaceRepoText(
  repo: string,
  path: string,
  oldText: string,
  newText: string,
): { path: string } {
  if (!oldText) throw new Error("old_text must not be empty");
  const resolved = existingPath(repo, path);
  assertReadableFile(resolved.abs, WRITE_CHARS_MAX);
  const content = readFileSync(resolved.abs, "utf8");
  const first = content.indexOf(oldText);
  if (first === -1) throw new Error("old_text was not found in the file");
  if (content.indexOf(oldText, first + oldText.length) !== -1) {
    throw new Error("old_text occurs more than once; provide a larger unique block");
  }
  const next = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
  return writeRepoFile(repo, path, next);
}

export function removeRepoFile(repo: string, path: string): { path: string } {
  const resolved = existingPath(repo, path);
  rmSync(resolved.abs);
  return { path: resolved.rel };
}

const PathInput = v.pipe(
  v.string(),
  v.description("repository-relative path; .git is unavailable"),
);

const listRepoFilesTool = defineTool({
  name: "list_repo_files",
  description:
    "List files under one repository-relative directory. Read-only, bounded, and confined to the target repository.",
  input: v.object({ path: v.optional(PathInput, ".") }),
  output: v.object({ files: v.array(v.string()), truncated: v.boolean() }),
  run: ({ input }) => listRepoFiles(REPO, input.path),
});

const readRepoFileTool = defineTool({
  name: "read_repo_file",
  description:
    "Read a bounded line range from one target-repository file. Use additional ranges when truncated.",
  input: v.object({
    path: PathInput,
    start_line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
    end_line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  }),
  output: v.object({ path: v.string(), content: v.string(), truncated: v.boolean() }),
  // An absent end_line stays undefined so readRepoFile's own default window
  // applies — the formula lives in one place.
  run: ({ input }) => readRepoFile(REPO, input.path, input.start_line, input.end_line),
});

const searchRepoTool = defineTool({
  name: "search_repo",
  description:
    "Search target-repository text for a literal string. Read-only, bounded, and repo-confined.",
  input: v.object({
    query: v.pipe(v.string(), v.minLength(1)),
    path: v.optional(PathInput, "."),
  }),
  output: v.object({ output: v.string(), truncated: v.boolean() }),
  run: ({ input }) => searchRepo(REPO, input.query, input.path),
});

const writeRepoFileTool = defineTool({
  name: "write_repo_file",
  description:
    "Create or replace one target-repository file. Paths are repo-confined and .git is unavailable. Use only for the minimal source fix.",
  input: v.object({ path: PathInput, content: v.string() }),
  output: v.object({ path: v.string() }),
  run: ({ input }) => writeRepoFile(REPO, input.path, input.content),
});

const replaceRepoTextTool = defineTool({
  name: "replace_repo_text",
  description:
    "Replace one exact, unique text block in a target-repository file. Fails when the block is absent or ambiguous.",
  input: v.object({
    path: PathInput,
    old_text: v.pipe(v.string(), v.minLength(1)),
    new_text: v.string(),
  }),
  output: v.object({ path: v.string() }),
  run: ({ input }) => replaceRepoText(REPO, input.path, input.old_text, input.new_text),
});

const removeRepoFileTool = defineTool({
  name: "remove_repo_file",
  description:
    "Remove one target-repository file when a dependency adaptation genuinely makes it obsolete. Repo-confined; .git is unavailable.",
  input: v.object({ path: PathInput }),
  output: v.object({ path: v.string() }),
  run: ({ input }) => removeRepoFile(REPO, input.path),
});

export const repoReadTools = [listRepoFilesTool, readRepoFileTool, searchRepoTool] as const;
export const repoWriteTools = [writeRepoFileTool, replaceRepoTextTool, removeRepoFileTool] as const;
