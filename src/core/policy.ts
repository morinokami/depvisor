import type { DepvisorConfig } from "./config.ts";
import type { DependencyChange, UpdateType } from "./types.ts";

function semverParts(value: string | null): [number, number, number] | null {
  if (!value) return null;
  const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function updateTypeFor(change: Pick<DependencyChange, "from" | "to">): UpdateType {
  if (change.from && change.to && change.from !== change.to && change.to.startsWith("sha256:")) {
    return "digest";
  }
  const from = semverParts(change.from);
  const to = semverParts(change.to);
  if (!from || !to) return "unknown";
  if (to[0] !== from[0]) return "major";
  if (to[1] !== from[1]) return "minor";
  if (to[2] !== from[2]) return "patch";
  return "unknown";
}

function selected(types: readonly string[], changes: readonly DependencyChange[]): boolean {
  return changes.some((change) => types.includes(updateTypeFor(change)));
}

export interface PolicyDecision {
  review: boolean;
  repair: boolean;
  overDependencyLimit: boolean;
  llmCalls: number;
}

export function decidePolicy(
  config: DepvisorConfig,
  changes: readonly DependencyChange[],
): PolicyDecision {
  const overDependencyLimit = changes.length > config.cost.max_dependencies_per_pr;
  let calls = config.cost.max_llm_calls_per_pr;
  const review =
    !overDependencyLimit &&
    config.report.enabled &&
    calls > 0 &&
    selected(config.report.update_types, changes);
  if (review) calls -= 1;
  const repair =
    !overDependencyLimit &&
    config.repair.enabled &&
    calls > 0 &&
    selected(config.repair.update_types, changes);
  return { review, repair, overDependencyLimit, llmCalls: Number(review) + Number(repair) };
}
