import type { DependencyChange } from "../core/types.ts";

export interface UpdateSnapshot {
  changedPaths: string[];
  readBase(path: string): string | null;
  readHead(path: string): string | null;
}

export interface EcosystemResult {
  claimedPaths: string[];
  changes: DependencyChange[];
  complete: boolean;
  reason: string | null;
}

export interface EcosystemAdapter {
  readonly id: string;
  matches(path: string): boolean;
  analyze(snapshot: UpdateSnapshot): EcosystemResult;
}
