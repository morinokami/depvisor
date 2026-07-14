import { diffPaths, fileAtRef } from "../core/git.ts";
import type { DependencyChange } from "../core/types.ts";
import { goModAdapter } from "./gomod.ts";
import { npmAdapter } from "./npm.ts";
import type { EcosystemAdapter, UpdateSnapshot } from "./types.ts";

export const ECOSYSTEM_ADAPTERS: readonly EcosystemAdapter[] = [npmAdapter, goModAdapter];

export interface NormalizedUpdate {
  changes: DependencyChange[];
  changedPaths: string[];
  protectedPaths: string[];
  repairSafe: boolean;
  genericReasons: string[];
}

export function normalizeUpdate(
  repo: string,
  mergeBaseSha: string,
  updaterHeadSha: string,
): NormalizedUpdate {
  const changedPaths = diffPaths(repo, mergeBaseSha, updaterHeadSha);
  const snapshot: UpdateSnapshot = {
    changedPaths,
    readBase: (path) => fileAtRef(repo, mergeBaseSha, path),
    readHead: (path) => fileAtRef(repo, updaterHeadSha, path),
  };
  const claimed = new Set<string>();
  const changes: DependencyChange[] = [];
  const genericReasons: string[] = [];
  for (const adapter of ECOSYSTEM_ADAPTERS) {
    if (!changedPaths.some((path) => adapter.matches(path))) continue;
    const result = adapter.analyze(snapshot);
    result.claimedPaths.forEach((path) => claimed.add(path));
    changes.push(...result.changes);
    if (!result.complete)
      genericReasons.push(result.reason ?? `${adapter.id} parsing was incomplete.`);
  }
  const unclaimed = changedPaths.filter((path) => !claimed.has(path));
  if (unclaimed.length > 0) {
    genericReasons.push(`Unclassified updater paths: ${unclaimed.join(", ")}`);
  }
  if (changes.length === 0 || genericReasons.length > 0) {
    changes.push({
      ecosystem: "unknown",
      manager: "unknown",
      package: "(unidentified update)",
      from: null,
      to: null,
      kind: "unknown",
      directness: "unknown",
      manifests: [],
      lockfiles: [],
      protectedPaths: [...new Set([...claimed, ...unclaimed])].toSorted(),
      capability: "generic-review",
      evidence: [
        {
          kind: "pr-diff",
          source: `${mergeBaseSha}...${updaterHeadSha}`,
          summary: genericReasons.join(" ") || "No ecosystem adapter identified the update.",
          untrusted: true,
        },
      ],
    });
  }
  const protectedPaths = [
    ...new Set(changes.flatMap((change) => change.protectedPaths)),
  ].toSorted();
  return {
    changes,
    changedPaths,
    protectedPaths,
    repairSafe: changes.every(
      (change) => change.capability === "repair-safe" || change.capability === "deep-evidence",
    ),
    genericReasons,
  };
}
