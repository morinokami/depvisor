import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunConfig, type ConfigEnv } from "../src/core/config.ts";

/** parseRunConfig on an env with no DEPVISOR_* knobs set at all. */
function defaults() {
  const parsed = parseRunConfig({});
  assert.ok(parsed.ok);
  return parsed.config;
}

/** The status of the first rejected knob, or null when the env parses. */
function rejection(env: ConfigEnv): { status: string; summary: string } | null {
  const parsed = parseRunConfig(env);
  return parsed.ok ? null : { status: parsed.status, summary: parsed.summary };
}

test("an empty env yields every documented default", () => {
  const config = defaults();
  assert.equal(config.openPullRequestsLimit, 5);
  assert.equal(config.minimumReleaseAge, 1);
  assert.equal(config.suggestFeatures, false);
  assert.equal(config.language, "");
  assert.equal(config.baseBranch, undefined);
  assert.equal(config.openPrsFile, undefined);
  assert.equal(config.verifyCommands, "");
  assert.equal(config.installCommand, "");
  assert.deepEqual([...config.releaseAgeExclude], []);
  assert.deepEqual(config.ignoreRules, []);
  assert.deepEqual(config.groupRules, []);
});

test("empty strings mean 'not set', as the composite action forwards them", () => {
  const parsed = parseRunConfig({
    DEPVISOR_BASE_BRANCH: "",
    DEPVISOR_OPEN_PRS_FILE: "",
    DEPVISOR_OPEN_PULL_REQUESTS_LIMIT: "",
    DEPVISOR_MINIMUM_RELEASE_AGE: "",
    DEPVISOR_SUGGEST_FEATURES: "",
    DEPVISOR_IGNORE: "",
    DEPVISOR_GROUPS: "",
    DEPVISOR_LANGUAGE: "",
  });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.config, defaults());
});

test("set knobs are carried through", () => {
  const parsed = parseRunConfig({
    DEPVISOR_BASE_BRANCH: "main",
    DEPVISOR_OPEN_PRS_FILE: "/tmp/open-prs.json",
    DEPVISOR_VERIFY_COMMANDS: "npm run ci",
    DEPVISOR_INSTALL_COMMAND: "npm ci",
    DEPVISOR_OPEN_PULL_REQUESTS_LIMIT: "3",
    DEPVISOR_MINIMUM_RELEASE_AGE: "0",
    DEPVISOR_MINIMUM_RELEASE_AGE_EXCLUDE: "@acme/private\n# a comment",
    DEPVISOR_IGNORE: "lodash\nreact@19",
    DEPVISOR_GROUPS: "react: react react-dom",
    DEPVISOR_SUGGEST_FEATURES: "true",
    DEPVISOR_LANGUAGE: "pt-BR",
  });
  assert.ok(parsed.ok);
  const config = parsed.config;
  assert.equal(config.baseBranch, "main");
  assert.equal(config.openPrsFile, "/tmp/open-prs.json");
  assert.equal(config.verifyCommands, "npm run ci");
  assert.equal(config.installCommand, "npm ci");
  assert.equal(config.openPullRequestsLimit, 3);
  assert.equal(config.minimumReleaseAge, 0);
  assert.equal(config.suggestFeatures, true);
  assert.equal(config.language, "pt-BR");
  assert.deepEqual([...config.releaseAgeExclude], ["@acme/private"]);
  assert.deepEqual(
    config.ignoreRules.map((r) => r.name),
    ["lodash", "react"],
  );
  assert.deepEqual(config.groupRules, [{ name: "react", packages: ["react", "react-dom"] }]);
});

test("each knob fails closed with its own bad-* status and echoes the value", () => {
  const cases: [ConfigEnv, string, string][] = [
    [{ DEPVISOR_OPEN_PULL_REQUESTS_LIMIT: " 0 " }, "bad-open-pull-requests-limit", "'0'"],
    [{ DEPVISOR_OPEN_PULL_REQUESTS_LIMIT: "many" }, "bad-open-pull-requests-limit", "'many'"],
    [{ DEPVISOR_MINIMUM_RELEASE_AGE: "-1" }, "bad-minimum-release-age", "'-1'"],
    [{ DEPVISOR_SUGGEST_FEATURES: "yes" }, "bad-suggest-features", "'yes'"],
    [{ DEPVISOR_LANGUAGE: "japanese please" }, "bad-language", "'japanese please'"],
  ];
  for (const [env, status, echoed] of cases) {
    const rejected = rejection(env);
    assert.equal(rejected?.status, status);
    assert.ok(rejected.summary.includes(echoed), `${status} summary should echo ${echoed}`);
  }
});

test("list knobs name every unrecognized entry, pluralized", () => {
  const one = rejection({ DEPVISOR_IGNORE: "not a package name" });
  assert.equal(one?.status, "bad-ignore");
  assert.ok(one.summary.includes("1 unrecognized entry:"));
  assert.ok(one.summary.includes("not a package name"));

  const two = rejection({ DEPVISOR_MINIMUM_RELEASE_AGE_EXCLUDE: "bad name\nlodash@4" });
  assert.equal(two?.status, "bad-minimum-release-age-exclude");
  assert.ok(two.summary.includes("2 unrecognized entries:"));
  assert.ok(two.summary.includes("bad name, lodash@4"));

  const groups = rejection({ DEPVISOR_GROUPS: "react react-dom\nreact: react\nweb: react" });
  assert.equal(groups?.status, "bad-groups");
  assert.ok(groups.summary.includes("2 invalid entries:"));
  assert.ok(groups.summary.includes("react react-dom")); // the line missing its ':'
  assert.ok(groups.summary.includes("'react'")); // the package claimed by two groups
});

test("the cooldown exclusion is validated even when the cooldown is disabled", () => {
  // A typo must fail now, not the day minimum_release_age is turned back on.
  const rejected = rejection({
    DEPVISOR_MINIMUM_RELEASE_AGE: "0",
    DEPVISOR_MINIMUM_RELEASE_AGE_EXCLUDE: "not a package name",
  });
  assert.equal(rejected?.status, "bad-minimum-release-age-exclude");
});

test("the first rejection wins, in the order the knobs are parsed", () => {
  const rejected = rejection({
    DEPVISOR_OPEN_PULL_REQUESTS_LIMIT: "nope",
    DEPVISOR_MINIMUM_RELEASE_AGE: "nope",
    DEPVISOR_IGNORE: "nope nope",
    DEPVISOR_SUGGEST_FEATURES: "nope",
    DEPVISOR_LANGUAGE: "nope nope",
  });
  assert.equal(rejected?.status, "bad-open-pull-requests-limit");
});
