/**
 * The one publication boundary v2 keeps around the autonomous agent.
 *
 * The updater owns dependency selection. depvisor therefore freezes every
 * path the updater changed, plus recognized dependency manifests, lockfiles,
 * and package-manager configuration (registry routing and install hooks),
 * before the agent starts. A repair may edit anything else, but it is not
 * published if one of these paths changes, appears, disappears, or changes
 * symlink target.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";
import { isSafeRepoPath } from "./paths.ts";

export interface DependencySnapshot {
  version: 1;
  files: Record<string, string | null>;
}

export function readDependencySnapshot(path: string): DependencySnapshot {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("Invalid dependency snapshot");
  const value = raw as Partial<DependencySnapshot>;
  if (value.version !== 1 || !value.files || typeof value.files !== "object") {
    throw new Error("Invalid dependency snapshot");
  }
  const files: Record<string, string | null> = {};
  for (const [name, hash] of Object.entries(value.files)) {
    if (
      !isSafeRepoPath(name) ||
      (hash !== null && (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)))
    ) {
      throw new Error("Invalid dependency snapshot entry");
    }
    files[name] = hash;
  }
  return { version: 1, files };
}

const EXACT_NAMES = new Set([
  ".gitmodules",
  ".npmrc",
  ".pnpmfile.cjs",
  ".yarnrc",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "flake.lock",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "gradle.lockfile",
  "gradle.properties",
  "libs.versions.toml",
  "mix.exs",
  "mix.lock",
  "npm-shrinkwrap.json",
  "nuget.config",
  "package-lock.json",
  "package.json",
  "package.resolved",
  "packages.lock.json",
  "paket.dependencies",
  "paket.lock",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "poetry.lock",
  "pubspec.lock",
  "pubspec.yaml",
  "pyproject.toml",
  "renovate.json",
  "renovate.json5",
  "requirements.in",
  "requirements.txt",
  "setup.cfg",
  "setup.py",
  "swift.package.resolved",
  "uv.lock",
  "yarn.lock",
  ".terraform.lock.hcl",
  "directory.packages.props",
  "global.json",
]);

const EXTENSIONS = [".csproj", ".fsproj", ".vbproj", ".slnx", ".gradle", ".gradle.kts"] as const;

/** Pure path classifier, intentionally broad across Dependabot ecosystems. */
export function isDependencyStatePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const name = basename(lower);

  if (EXACT_NAMES.has(name)) return true;
  if (/^requirements([-.].+)?\.(in|txt)$/.test(name)) return true;
  if (/^(dockerfile|containerfile)(\..+)?$/.test(name)) return true;
  if (/^pom\.xml$/.test(name) || /^settings\.xml$/.test(name)) return true;
  if (EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  if (lower === ".github/dependabot.yml" || lower === ".github/dependabot.yaml") return true;
  if (lower.endsWith("/.config/dotnet-tools.json") || lower === ".config/dotnet-tools.json") {
    return true;
  }
  if (lower.startsWith(".devcontainer/") && lower.endsWith("devcontainer.json")) return true;
  return false;
}

function ignoredDirectory(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".venv" ||
    name === "vendor" ||
    name === "target" ||
    name === "dist" ||
    name === "build"
  );
}

/** Discover dependency-state paths without executing repository code or git. */
export function discoverDependencyStatePaths(repo: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectory(entry.name)) continue;
      const absolute = join(dir, entry.name);
      const path = relative(repo, absolute).split(sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      else if (isDependencyStatePath(path)) found.push(path);
    }
  };
  visit(repo);
  return found.toSorted();
}

function hashPath(repo: string, path: string): string | null {
  const absolute = join(repo, path);
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) {
    hash.update("symlink\0");
    hash.update(readlinkSync(absolute));
  } else if (stat.isFile()) {
    hash.update("file\0");
    hash.update(readFileSync(absolute));
  } else {
    hash.update(`other\0${stat.mode}`);
  }
  return hash.digest("hex");
}

export function snapshotDependencyState(
  repo: string,
  updaterPaths: readonly string[] = [],
): DependencySnapshot {
  const paths = new Set([...discoverDependencyStatePaths(repo), ...updaterPaths]);
  const files: Record<string, string | null> = {};
  for (const path of [...paths].toSorted()) files[path] = hashPath(repo, path);
  return { version: 1, files };
}

/** Return frozen paths whose current value differs from the pre-agent value. */
export function changedDependencyState(repo: string, snapshot: DependencySnapshot): string[] {
  const currentPaths = new Set(discoverDependencyStatePaths(repo));
  const paths = new Set([...Object.keys(snapshot.files), ...currentPaths]);
  return [...paths]
    .filter((path) => hashPath(repo, path) !== (snapshot.files[path] ?? null))
    .toSorted();
}
