/** Go modules is the first non-JS repair-safe adapter. */

import type { DependencyChange } from "../core/types.ts";
import type { EcosystemAdapter, EcosystemResult } from "./types.ts";

interface GoRequirement {
  version: string;
  indirect: boolean;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isGoPath(path: string): boolean {
  const base = basename(path);
  return (
    base === "go.mod" ||
    base === "go.sum" ||
    base === "go.work" ||
    base === "go.work.sum" ||
    path === "vendor/modules.txt" ||
    path.startsWith("vendor/")
  );
}

function parseRequirement(line: string): [string, GoRequirement] | null {
  const clean = line.trim();
  if (!clean || clean.startsWith("//")) return null;
  const match = /^(\S+)\s+(v\S+)(?:\s+\/\/\s*indirect)?$/.exec(clean);
  if (!match?.[1] || !match[2]) return null;
  return [match[1], { version: match[2], indirect: /\/\/\s*indirect/.test(clean) }];
}

function parseGoMod(source: string | null): Map<string, GoRequirement> | null {
  if (source === null) return new Map();
  const requirements = new Map<string, GoRequirement>();
  let block = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "require (") {
      block = true;
      continue;
    }
    if (block && line === ")") {
      block = false;
      continue;
    }
    if (block) {
      const parsed = parseRequirement(line);
      if (parsed) requirements.set(...parsed);
      else if (line && !line.startsWith("//")) return null;
      continue;
    }
    if (line.startsWith("require ")) {
      const parsed = parseRequirement(line.slice("require ".length));
      if (!parsed) return null;
      requirements.set(...parsed);
    }
  }
  if (block) return null;
  return requirements;
}

export const goModAdapter: EcosystemAdapter = {
  id: "go",
  matches: isGoPath,
  analyze(snapshot): EcosystemResult {
    const claimedPaths = snapshot.changedPaths.filter(isGoPath);
    const manifests = claimedPaths.filter((path) => basename(path) === "go.mod");
    const lockfiles = claimedPaths.filter((path) => {
      const base = basename(path);
      return base === "go.sum" || base === "go.work.sum" || path === "vendor/modules.txt";
    });
    const protectedPaths = claimedPaths.toSorted();
    const changes: DependencyChange[] = [];
    for (const manifest of manifests) {
      const before = parseGoMod(snapshot.readBase(manifest));
      const after = parseGoMod(snapshot.readHead(manifest));
      if (!before || !after) {
        return {
          claimedPaths,
          changes: [],
          complete: false,
          reason: `${manifest} could not be parsed completely.`,
        };
      }
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        const oldRequirement = before.get(name);
        const newRequirement = after.get(name);
        const from = oldRequirement?.version ?? null;
        const to = newRequirement?.version ?? null;
        if (from === to && oldRequirement?.indirect === newRequirement?.indirect) continue;
        changes.push({
          ecosystem: "go",
          manager: "gomod",
          package: name,
          from,
          to,
          kind: "runtime",
          directness: newRequirement?.indirect ? "transitive" : "direct",
          manifests: [manifest],
          lockfiles,
          protectedPaths,
          capability: "repair-safe",
          evidence: [
            {
              kind: "pr-diff",
              source: manifest,
              summary: `${name} changed from ${from ?? "absent"} to ${to ?? "absent"}.`,
              untrusted: true,
            },
          ],
        });
      }
    }
    if (changes.length === 0) {
      return {
        claimedPaths,
        changes: [],
        complete: false,
        reason: "Go dependency state changed without an attributable go.mod requirement.",
      };
    }
    return { claimedPaths, changes, complete: true, reason: null };
  },
};
