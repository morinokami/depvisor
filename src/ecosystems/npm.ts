/** package.json/lockfile parsing only; no package manager is executed. */

import type { DependencyChange } from "../core/types.ts";
import type { EcosystemAdapter, EcosystemResult, UpdateSnapshot } from "./types.ts";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const CONFIG_FILES = new Set([
  "pnpm-workspace.yaml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "bunfig.toml",
]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isManifest(path: string): boolean {
  return basename(path) === "package.json";
}

function isNpmPath(path: string): boolean {
  const base = basename(path);
  return (
    isManifest(path) || LOCKFILES.has(base) || CONFIG_FILES.has(base) || path.startsWith(".yarn/")
  );
}

function parseManifest(source: string | null): Record<string, unknown> | null {
  if (source === null) return {};
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null;
  } catch {
    return null;
  }
}

function stringMap(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    result[key] = entry;
  }
  return result;
}

function managerFor(paths: readonly string[]): string | null {
  const names = new Set(paths.map(basename));
  const managers = [
    names.has("package-lock.json") || names.has("npm-shrinkwrap.json") ? "npm" : null,
    names.has("pnpm-lock.yaml") ? "pnpm" : null,
    names.has("bun.lock") || names.has("bun.lockb") ? "bun" : null,
    names.has("yarn.lock") ? "yarn" : null,
  ].filter((manager): manager is string => manager !== null);
  if (managers.length > 1) return null;
  return managers[0] ?? "npm";
}

function packageChanges(
  snapshot: UpdateSnapshot,
  manifest: string,
  manager: string,
  protectedPaths: string[],
  lockfiles: string[],
): DependencyChange[] | null {
  const before = parseManifest(snapshot.readBase(manifest));
  const after = parseManifest(snapshot.readHead(manifest));
  if (!before || !after) return null;
  const changes: DependencyChange[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const oldDependencies = stringMap(before[field]);
    const newDependencies = stringMap(after[field]);
    if (!oldDependencies || !newDependencies) return null;
    for (const name of new Set([
      ...Object.keys(oldDependencies),
      ...Object.keys(newDependencies),
    ])) {
      const from = oldDependencies[name] ?? null;
      const to = newDependencies[name] ?? null;
      if (from === to) continue;
      changes.push({
        ecosystem: "javascript",
        manager,
        package: name,
        from,
        to,
        kind: field === "devDependencies" ? "development" : "runtime",
        directness: "direct",
        manifests: [manifest],
        lockfiles,
        protectedPaths,
        capability: "repair-safe",
        evidence: [
          {
            kind: "pr-diff",
            source: manifest,
            summary: `${field}.${name} changed from ${from ?? "absent"} to ${to ?? "absent"}.`,
            untrusted: true,
          },
        ],
      });
    }
  }
  return changes;
}

export const npmAdapter: EcosystemAdapter = {
  id: "javascript",
  matches: isNpmPath,
  analyze(snapshot): EcosystemResult {
    const claimedPaths = snapshot.changedPaths.filter(isNpmPath);
    const manifests = claimedPaths.filter(isManifest);
    const lockfiles = claimedPaths.filter((path) => LOCKFILES.has(basename(path)));
    const manager = managerFor(claimedPaths);
    const protectedPaths = claimedPaths.toSorted();
    if (manager === null) {
      return {
        claimedPaths,
        changes: [],
        complete: false,
        reason: "Ambiguous JavaScript lockfile mix cannot be scoped safely.",
      };
    }
    const changes: DependencyChange[] = [];
    for (const manifest of manifests) {
      const parsed = packageChanges(snapshot, manifest, manager, protectedPaths, lockfiles);
      if (!parsed) {
        return {
          claimedPaths,
          changes: [],
          complete: false,
          reason: `${manifest} could not be parsed completely.`,
        };
      }
      changes.push(...parsed);
    }
    const configChanged = claimedPaths.some(
      (path) => CONFIG_FILES.has(basename(path)) || path.startsWith(".yarn/"),
    );
    if (changes.length === 0 || (configChanged && manifests.length === 0)) {
      return {
        claimedPaths,
        changes: [],
        complete: false,
        reason: "JavaScript dependency state changed without an attributable manifest dependency.",
      };
    }
    return { claimedPaths, changes, complete: true, reason: null };
  },
};
