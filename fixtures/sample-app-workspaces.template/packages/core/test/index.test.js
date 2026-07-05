const test = require("node:test");
const assert = require("node:assert");
const { isNewer, remember } = require("../dist/index.js");

test("isNewer compares semver correctly", () => {
  assert.strictEqual(isNewer("2.0.0", "1.0.0"), true);
  assert.strictEqual(isNewer("1.0.0", "2.0.0"), false);
});

test("remember returns and caches a computed value", () => {
  let calls = 0;
  const make = () => {
    calls += 1;
    return "value";
  };
  assert.strictEqual(remember("k", make), "value");
  assert.strictEqual(remember("k", make), "value");
  assert.strictEqual(calls, 1);
});
