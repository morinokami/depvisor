import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/core/config.ts";
import { AGENT_EMAIL } from "../src/core/git.ts";
import { admitProvider } from "../src/providers/index.ts";
import type { GitHubCommitIdentity } from "../src/providers/types.ts";

const configResult = parseConfig(`
version: 2
repair: {enabled: true}
verification: {commands: [npm test]}
updaters:
  dependabot: {enabled: true}
  renovate: {enabled: true, trusted_actors: ['renovate[bot]', 'self-hosted-renovate[bot]', 'renovate-service'], rebase_label: rebase}
report: {enabled: true, update_types: [major]}
`);
assert.equal(configResult.ok, true);
const config = configResult.ok ? configResult.config : null!;
const bot = (login: string) => ({ login, id: 42, type: "Bot" });

function commit(sha: string, login: string): GitHubCommitIdentity {
  return {
    sha,
    message: "chore(deps): update",
    parents: ["0".repeat(40)],
    author: bot(login),
    committer: bot(login),
    committerEmail: `${login}@users.noreply.github.com`,
  };
}

test("Dependabot is attested from API actor and commit identities", () => {
  const head = "a".repeat(40);
  const result = admitProvider(
    {
      actor: bot("dependabot[bot]"),
      headRepository: "o/r",
      baseRepository: "o/r",
      headRef: "dependabot/npm/a-2",
    },
    [commit(head, "dependabot[bot]")],
    config,
  );
  assert.equal(result.status, null);
  assert.equal(result.updaterHeadSha, head);
});

test("a recognized depvisor tip names exactly one provider head", () => {
  const updater = "b".repeat(40);
  const repair = "c".repeat(40);
  const result = admitProvider(
    {
      actor: bot("dependabot[bot]"),
      headRepository: "o/r",
      baseRepository: "o/r",
      headRef: "dependabot/npm/a-2",
    },
    [
      commit(updater, "dependabot[bot]"),
      {
        sha: repair,
        message: `fix(deps): adapt\n\nDepvisor-Updater-Head: ${updater}\n\n[dependabot skip]`,
        parents: [updater],
        author: bot("github-actions[bot]"),
        committer: null,
        committerEmail: AGENT_EMAIL,
      },
    ],
    config,
  );
  assert.equal(result.existingRepair, true);
  assert.equal(result.updaterHeadSha, updater);
});

test("human takeover is neutral and a convincing branch name grants nothing", () => {
  const human = { login: "alice", id: 7, type: "User" };
  const result = admitProvider(
    {
      actor: bot("renovate[bot]"),
      headRepository: "o/r",
      baseRepository: "o/r",
      headRef: "renovate/looks-valid",
    },
    [{ ...commit("d".repeat(40), "renovate[bot]"), author: human }],
    config,
  );
  assert.equal(result.status, "human-takeover");

  const fake = admitProvider(
    {
      actor: bot("mallory[bot]"),
      headRepository: "o/r",
      baseRepository: "o/r",
      headRef: "renovate/x",
    },
    [commit("e".repeat(40), "mallory[bot]")],
    config,
  );
  assert.equal(fake.status, "unsupported-provider");
});

test("an explicitly trusted self-hosted Renovate service user is not human takeover", () => {
  const service = { login: "renovate-service", id: 84, type: "User" };
  const result = admitProvider(
    {
      actor: service,
      headRepository: "o/r",
      baseRepository: "o/r",
      headRef: "renovate/service-update",
    },
    [
      {
        ...commit("f".repeat(40), "renovate[bot]"),
        author: service,
        committer: service,
      },
    ],
    config,
  );
  assert.equal(result.status, null);
  assert.equal(result.provider, "renovate");
});

test("the depvisor trailer and sentinel email do not attest an impostor repair", () => {
  const updater = "1".repeat(40);
  const result = admitProvider(
    {
      actor: bot("dependabot[bot]"),
      headRepository: "o/r",
      baseRepository: "o/r",
      headRef: "dependabot/npm/a-2",
    },
    [
      commit(updater, "dependabot[bot]"),
      {
        sha: "2".repeat(40),
        message: `fix(deps): adapt\n\nDepvisor-Updater-Head: ${updater}`,
        parents: [updater],
        author: bot("mallory[bot]"),
        committer: null,
        committerEmail: AGENT_EMAIL,
      },
    ],
    config,
  );
  assert.equal(result.status, "untrusted-updater");
  assert.equal(result.existingRepair, false);
});
