import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePrNumber, parseRefName, parseRunConfig, type ConfigEnv } from "../src/core/config.ts";

/** The status of the first rejected knob, or null when the env parses. */
function rejection(env: ConfigEnv): { status: string; summary: string } | null {
  const parsed = parseRunConfig(env);
  return parsed.ok ? null : { status: parsed.status, summary: parsed.summary };
}

test("an empty env fails closed: base_ref is required, not defaulted", () => {
  // An aftercare run without a base has nothing to attribute against, so the
  // one required knob must fail loudly instead of guessing 'main'.
  const rejected = rejection({});
  assert.ok(rejected);
  assert.equal(rejected.status, "bad-base-ref");
  assert.match(rejected.summary, /base_ref input is required/);
});

test("with only base_ref set, every other knob takes its documented default", () => {
  const parsed = parseRunConfig({ DEPVISOR_BASE_REF: "main" });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.config, {
    baseRef: "main",
    headRef: undefined,
    prNumber: undefined,
    verifyCommands: "",
    installCommand: "",
    language: "",
  });
});

test("empty strings mean 'not set', as the composite action forwards them", () => {
  const parsed = parseRunConfig({
    DEPVISOR_BASE_REF: "main",
    DEPVISOR_HEAD_REF: "",
    DEPVISOR_PR_NUMBER: "",
    DEPVISOR_VERIFY_COMMANDS: "",
    DEPVISOR_INSTALL_COMMAND: "",
    DEPVISOR_LANGUAGE: "",
  });
  assert.ok(parsed.ok);
  const base = parseRunConfig({ DEPVISOR_BASE_REF: "main" });
  assert.ok(base.ok);
  assert.deepEqual(parsed.config, base.config);
});

test("set knobs are carried through (refs trimmed, pr_number numeric)", () => {
  const parsed = parseRunConfig({
    DEPVISOR_BASE_REF: " main ",
    DEPVISOR_HEAD_REF: "dependabot/npm_and_yarn/lru-cache-11.0.0",
    DEPVISOR_PR_NUMBER: "42",
    DEPVISOR_VERIFY_COMMANDS: "make check\nmake e2e",
    DEPVISOR_INSTALL_COMMAND: "npm ci --ignore-scripts",
    DEPVISOR_LANGUAGE: "pt-BR",
  });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.config, {
    baseRef: "main",
    headRef: "dependabot/npm_and_yarn/lru-cache-11.0.0",
    prNumber: 42,
    verifyCommands: "make check\nmake e2e",
    installCommand: "npm ci --ignore-scripts",
    language: "pt-BR",
  });
});

test("each knob fails closed with its own bad-* status and echoes the value", () => {
  const base = { DEPVISOR_BASE_REF: "main" };
  // The ref knobs are embedded in git command lines and the status file, so
  // anything outside plain branch naming must be refused, not passed through.
  const cases: [ConfigEnv, string, string][] = [
    [{ DEPVISOR_BASE_REF: "../evil" }, "bad-base-ref", "'../evil'"],
    [{ ...base, DEPVISOR_HEAD_REF: "-x" }, "bad-head-ref", "'-x'"], // option injection
    [{ ...base, DEPVISOR_HEAD_REF: "a..b" }, "bad-head-ref", "'a..b'"], // range syntax
    [{ ...base, DEPVISOR_HEAD_REF: "feature/" }, "bad-head-ref", "'feature/'"],
    [{ ...base, DEPVISOR_HEAD_REF: "branch.lock" }, "bad-head-ref", "'branch.lock'"],
    [{ ...base, DEPVISOR_PR_NUMBER: "0" }, "bad-pr-number", "'0'"],
    [{ ...base, DEPVISOR_PR_NUMBER: "abc" }, "bad-pr-number", "'abc'"],
    [{ ...base, DEPVISOR_PR_NUMBER: "1.5" }, "bad-pr-number", "'1.5'"],
    [{ ...base, DEPVISOR_LANGUAGE: "not a tag!" }, "bad-language", "'not a tag!'"],
  ];
  for (const [env, status, echoed] of cases) {
    const rejected = rejection(env);
    assert.ok(rejected, status);
    assert.equal(rejected.status, status);
    assert.ok(rejected.summary.includes(echoed), `${status} summary should echo ${echoed}`);
  }
});

test("the first rejection wins, in the order the knobs are parsed", () => {
  // Two mistyped knobs report only the first: enough to send the user to
  // their workflow file without a wall of statuses.
  const baseFirst = rejection({
    DEPVISOR_BASE_REF: "../evil",
    DEPVISOR_HEAD_REF: "-x",
    DEPVISOR_PR_NUMBER: "abc",
    DEPVISOR_LANGUAGE: "not a tag!",
  });
  assert.equal(baseFirst?.status, "bad-base-ref");

  const headFirst = rejection({
    DEPVISOR_BASE_REF: "main",
    DEPVISOR_HEAD_REF: "-x",
    DEPVISOR_PR_NUMBER: "abc",
    DEPVISOR_LANGUAGE: "not a tag!",
  });
  assert.equal(headFirst?.status, "bad-head-ref");

  const prBeforeLanguage = rejection({
    DEPVISOR_BASE_REF: "main",
    DEPVISOR_PR_NUMBER: "abc",
    DEPVISOR_LANGUAGE: "not a tag!",
  });
  assert.equal(prBeforeLanguage?.status, "bad-pr-number");
});

test("parseRefName: real updater branch names pass; git-hostile shapes are null", () => {
  // "" stays "" (= unset), and surrounding whitespace is trimmed.
  assert.equal(parseRefName(""), "");
  assert.equal(parseRefName("  "), "");
  assert.equal(parseRefName(" main "), "main");
  // The charset exists to serve exactly these: real Dependabot/Renovate branches.
  assert.equal(
    parseRefName("dependabot/npm_and_yarn/lru-cache-11.0.0"),
    "dependabot/npm_and_yarn/lru-cache-11.0.0",
  );
  assert.equal(parseRefName("renovate/lru-cache-11.x"), "renovate/lru-cache-11.x");
  for (const bad of [
    "../evil", // path escape
    "-x", // would parse as a git option
    ".hidden", // leading '.' is invalid in refs
    "/abs",
    "a..b", // revision-range syntax
    "feature/", // trailing '/' is invalid in refs
    "branch.lock", // reflock collision
    "a b",
    "a\nb",
    "$(true)",
  ]) {
    assert.equal(parseRefName(bad), null, `should reject '${bad}'`);
  }
});

test("parsePrNumber: '' stays unset; only a plain positive integer parses", () => {
  assert.equal(parsePrNumber(""), "");
  assert.equal(parsePrNumber("  "), "");
  assert.equal(parsePrNumber("42"), 42);
  assert.equal(parsePrNumber(" 7 "), 7);
  for (const bad of ["0", "-1", "abc", "1.5", "007", "1e3", "99999999999999999999"]) {
    assert.equal(parsePrNumber(bad), null, `should reject '${bad}'`);
  }
});
