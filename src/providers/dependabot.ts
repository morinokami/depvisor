import type { ProviderAdapter } from "./types.ts";

const LOGIN = "dependabot[bot]";

export const dependabotAdapter: ProviderAdapter = {
  id: "dependabot",
  claims: (actor) => actor.login === LOGIN,
  attest: (actor) => actor.login === LOGIN && actor.type === "Bot" && actor.id > 0,
  allowsHumanActor: () => false,
  ownsCommit: (commit) =>
    (commit.author?.login === LOGIN || commit.committer?.login === LOGIN) &&
    (commit.author?.type === "Bot" || commit.committer?.type === "Bot"),
  enabled: (config) => config.updaters.dependabot.enabled,
  repairCommitSuffix: "\n\n[dependabot skip]",
  refresh: () => ({ kind: "comment", value: "@dependabot rebase" }),
};
