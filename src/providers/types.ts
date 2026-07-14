import type { DepvisorConfig } from "../core/config.ts";
import type { Provider, V2Status } from "../core/types.ts";

export interface GitHubActor {
  login: string;
  id: number;
  type: string;
}

export interface GitHubCommitIdentity {
  sha: string;
  message: string;
  parents: string[];
  author: GitHubActor | null;
  committer: GitHubActor | null;
  committerEmail: string | null;
}

export interface ProviderPullRequest {
  actor: GitHubActor;
  headRepository: string;
  baseRepository: string;
  headRef: string;
}

export type RefreshInstruction =
  | { kind: "comment"; value: string }
  | { kind: "label"; value: string }
  | { kind: "manual"; value: string };

export interface ProviderAdapter {
  readonly id: Provider;
  claims(actor: GitHubActor, config: DepvisorConfig): boolean;
  attest(actor: GitHubActor, config: DepvisorConfig): boolean;
  allowsHumanActor(actor: GitHubActor, config: DepvisorConfig): boolean;
  ownsCommit(commit: GitHubCommitIdentity, config: DepvisorConfig): boolean;
  enabled(config: DepvisorConfig): boolean;
  repairCommitSuffix: string;
  refresh(config: DepvisorConfig): RefreshInstruction;
}

export interface ProviderAdmission {
  status: V2Status | null;
  provider: Provider | null;
  updaterHeadSha: string | null;
  existingRepair: boolean;
  refresh: RefreshInstruction | null;
  summary: string;
}
