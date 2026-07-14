import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/core/config.ts";

const valid = `
version: 2
repair:
  enabled: true
verification:
  commands: [pnpm run check]
report:
  enabled: true
  update_types: [minor, major, unknown]
`;

test("v2 config is explicit, strict, and content-addressed", () => {
  const parsed = parseConfig(valid);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.version, 2);
  assert.deepEqual(parsed.config.verification.prepare, []);
  assert.match(parsed.digest, /^[0-9a-f]{64}$/);
});

test("missing, old, and unknown-key configs fail closed", () => {
  assert.equal(parseConfig(null).ok, false);
  assert.equal(parseConfig(valid.replace("version: 2", "version: 1")).ok, false);
  assert.equal(parseConfig(`${valid}\nignore: [react]\n`).ok, false);
  assert.equal(
    parseConfig(valid.replace("enabled: true", "enabled: true\n  dry_run: true")).ok,
    false,
  );
  assert.equal(parseConfig(valid.replace("pnpm run check", "'   '")).ok, false);
  assert.equal(parseConfig(`${valid}\n# ${"x".repeat(70_000)}`).ok, false);
});

test("review-only config may omit verification commands", () => {
  const parsed = parseConfig(`
version: 2
repair: {enabled: false}
report: {enabled: true, update_types: [unknown]}
`);
  assert.equal(parsed.ok, true);
});
