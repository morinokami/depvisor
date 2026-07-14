/** Source/test-only candidate gate, parameterized by ecosystem protected paths. */

import { changedPaths, diffPaths } from "./git.ts";
import { isTestPath } from "./test-changes.ts";

const PATCH_MAX_BYTES = 2 * 1024 * 1024;

const DEPENDENCY_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
]);

const EXECUTION_SURFACES: RegExp[] = [
  /^\.git(?:\/|$)/,
  /^\.github\//,
  /^\.circleci\//,
  /^\.husky\//,
  /^\.githooks\//,
  /^\.gitlab-ci\.yml$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc(?:\.yml)?$/,
  /(^|\/)\.pnpmfile\.(?:cjs|js)$/,
  /^\.yarn\//,
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /^(?:script|scripts|bin)\//,
  /(^|\/)bunfig\.toml$/,
  /(^|\/)Dockerfile(?:\..*)?$/,
  /(^|\/)Makefile$/,
  /(^|\/)(?:eslint|vite|vitest|jest|webpack|rollup|babel|tsup|next|nuxt|svelte|astro|playwright|cypress|ava|karma)\.config\.[^/]+$/,
  /(^|\/)(?:setup|conftest)\.py$/,
];

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".cs",
  ".css",
  ".ex",
  ".exs",
  ".go",
  ".graphql",
  ".gql",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".mjs",
  ".cjs",
  ".php",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".wasm",
  ".zig",
]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extension(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

function isSourceOrTest(path: string): boolean {
  return isTestPath(path) || SOURCE_EXTENSIONS.has(extension(path));
}

export interface ScopeResult {
  ok: boolean;
  violations: string[];
}

export function checkScopePaths(
  paths: readonly string[],
  protectedPaths: readonly string[],
): ScopeResult {
  const protectedSet = new Set(protectedPaths);
  const violations: string[] = [];
  for (const path of new Set(paths)) {
    const base = basename(path);
    if (protectedSet.has(path)) violations.push(`${path} (adapter-protected)`);
    else if (DEPENDENCY_BASENAMES.has(base)) violations.push(`${path} (dependency state)`);
    else if (EXECUTION_SURFACES.some((pattern) => pattern.test(path))) {
      violations.push(`${path} (execution surface)`);
    } else if (!isSourceOrTest(path)) {
      violations.push(`${path} (not recognized source or test)`);
    }
  }
  return { ok: violations.length === 0, violations: violations.toSorted() };
}

export function checkCandidateScope(
  repo: string,
  updaterHeadSha: string,
  protectedPaths: readonly string[],
): ScopeResult {
  const paths = new Set(changedPaths(repo));
  const head = (() => {
    try {
      return diffPaths(repo, updaterHeadSha, "HEAD");
    } catch {
      return [];
    }
  })();
  head.forEach((path) => paths.add(path));
  return checkScopePaths([...paths], protectedPaths);
}

export function validatePatchEnvelope(patch: string): ScopeResult {
  const violations: string[] = [];
  if (Buffer.byteLength(patch) > PATCH_MAX_BYTES) violations.push("patch exceeds 2 MiB");
  if (patch.includes("\0")) violations.push("patch contains a NUL byte");
  if (patch && !patch.startsWith("diff --git ")) violations.push("patch is not a git diff");
  if (!patch) violations.push("patch is empty");
  return { ok: violations.length === 0, violations };
}
