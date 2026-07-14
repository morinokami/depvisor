/** Provider attestation is independent from ecosystem parsing. */

import { AGENT_EMAIL } from "../core/git.ts";
import type { DepvisorConfig } from "../core/config.ts";
import { dependabotAdapter } from "./dependabot.ts";
import { renovateAdapter } from "./renovate.ts";
import type {
  GitHubCommitIdentity,
  ProviderAdapter,
  ProviderAdmission,
  ProviderPullRequest,
} from "./types.ts";

export const PROVIDER_ADAPTERS = [dependabotAdapter, renovateAdapter] as const;

const TRAILER = /^Depvisor-Updater-Head: ([0-9a-f]{40})$/gm;

export function repairUpdaterHead(commit: GitHubCommitIdentity): string | null {
  if (
    commit.committerEmail !== AGENT_EMAIL ||
    commit.parents.length !== 1 ||
    commit.author?.login !== "github-actions[bot]" ||
    commit.author.type !== "Bot"
  ) {
    return null;
  }
  const matches = [...commit.message.matchAll(TRAILER)];
  const match = matches.length === 1 ? matches[0] : null;
  if (!match?.[1] || match[1] !== commit.parents[0]) return null;
  return match[1];
}

function containsUntrustedHuman(
  adapter: ProviderAdapter,
  commit: GitHubCommitIdentity,
  config: DepvisorConfig,
): boolean {
  return [commit.author, commit.committer].some(
    (actor) => actor?.type === "User" && !adapter.allowsHumanActor(actor, config),
  );
}

export function admitProvider(
  pr: ProviderPullRequest,
  commits: readonly GitHubCommitIdentity[],
  config: DepvisorConfig,
): ProviderAdmission {
  const adapter = PROVIDER_ADAPTERS.find((candidate) => candidate.claims(pr.actor, config));
  if (!adapter) {
    const human = pr.actor.type === "User";
    return {
      status: human ? "not-updater" : "unsupported-provider",
      provider: null,
      updaterHeadSha: null,
      existingRepair: false,
      refresh: null,
      summary: human
        ? "The pull request was opened by an ordinary user."
        : `No provider adapter trusts ${pr.actor.login}.`,
    };
  }
  if (!adapter.enabled(config)) {
    return {
      status: "policy-skipped",
      provider: adapter.id,
      updaterHeadSha: null,
      existingRepair: false,
      refresh: null,
      summary: `${adapter.id} is disabled in trusted base-tip configuration.`,
    };
  }
  if (!adapter.attest(pr.actor, config)) {
    return {
      status: "untrusted-updater",
      provider: adapter.id,
      updaterHeadSha: null,
      existingRepair: false,
      refresh: null,
      summary: `The ${adapter.id} identity did not pass actor attestation.`,
    };
  }
  if (commits.length === 0) {
    return {
      status: "untrusted-updater",
      provider: adapter.id,
      updaterHeadSha: null,
      existingRepair: false,
      refresh: null,
      summary: "The PR has no attributable commit chain.",
    };
  }

  const last = commits.at(-1)!;
  const repairHead = repairUpdaterHead(last);
  const providerCommits = repairHead ? commits.slice(0, -1) : commits;
  if (repairHead && providerCommits.at(-1)?.sha !== repairHead) {
    return {
      status: "untrusted-updater",
      provider: adapter.id,
      updaterHeadSha: null,
      existingRepair: false,
      refresh: null,
      summary: "The depvisor trailer does not name the immediately preceding provider commit.",
    };
  }

  for (const [index, commit] of providerCommits.entries()) {
    if (repairUpdaterHead(commit)) {
      return {
        status: "unexpected-commits",
        provider: adapter.id,
        updaterHeadSha: null,
        existingRepair: false,
        refresh: null,
        summary: "A depvisor repair was found below the PR tip; repairs may not be stacked.",
      };
    }
    if (containsUntrustedHuman(adapter, commit, config)) {
      return {
        status: "human-takeover",
        provider: adapter.id,
        updaterHeadSha: null,
        existingRepair: false,
        refresh: null,
        summary: "A positively identified human commit has taken ownership of the updater branch.",
      };
    }
    if (
      commit.parents.length !== 1 ||
      (index > 0 && commit.parents[0] !== providerCommits[index - 1]?.sha)
    ) {
      return {
        status: "unexpected-commits",
        provider: adapter.id,
        updaterHeadSha: null,
        existingRepair: false,
        refresh: null,
        summary: `Commit ${commit.sha} is not part of one linear provider-owned history.`,
      };
    }
    if (!adapter.ownsCommit(commit, config)) {
      return {
        status: "untrusted-updater",
        provider: adapter.id,
        updaterHeadSha: null,
        existingRepair: false,
        refresh: null,
        summary: `Commit ${commit.sha} could not be attributed to ${adapter.id}.`,
      };
    }
  }

  return {
    status: null,
    provider: adapter.id,
    updaterHeadSha: repairHead ?? last.sha,
    existingRepair: repairHead !== null,
    refresh: adapter.refresh(config),
    summary: repairHead
      ? `Recognized an existing depvisor repair above the ${adapter.id} head.`
      : `Attested a provider-owned ${adapter.id} head.`,
  };
}

export function adapterFor(id: "dependabot" | "renovate"): ProviderAdapter {
  return id === "dependabot" ? dependabotAdapter : renovateAdapter;
}
