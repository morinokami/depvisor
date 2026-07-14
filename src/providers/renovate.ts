import type { ProviderAdapter } from "./types.ts";

function trusted(config: Parameters<ProviderAdapter["attest"]>[1]): Set<string> {
  return new Set(config.updaters.renovate.trusted_actors);
}

export const renovateAdapter: ProviderAdapter = {
  id: "renovate",
  claims: (actor, config) => trusted(config).has(actor.login),
  attest: (actor, config) =>
    trusted(config).has(actor.login) &&
    (actor.type === "Bot" || (actor.type === "User" && !actor.login.endsWith("[bot]"))) &&
    actor.id > 0,
  allowsHumanActor: (actor, config) =>
    actor.type === "User" && !actor.login.endsWith("[bot]") && trusted(config).has(actor.login),
  ownsCommit: (commit, config) => {
    const actors = trusted(config);
    const owns = (actor: NonNullable<typeof commit.author>) =>
      actors.has(actor.login) &&
      (actor.type === "Bot" || (actor.type === "User" && !actor.login.endsWith("[bot]")));
    return (
      (commit.author !== null && owns(commit.author)) ||
      (commit.committer !== null && owns(commit.committer))
    );
  },
  enabled: (config) => config.updaters.renovate.enabled,
  repairCommitSuffix: "",
  refresh: (config) =>
    config.updaters.renovate.rebase_label
      ? { kind: "label", value: config.updaters.renovate.rebase_label }
      : {
          kind: "manual",
          value: "Use Renovate's rebase/retry checkbox to regenerate this branch.",
        },
};
