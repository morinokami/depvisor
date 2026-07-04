const test = require("node:test");
const assert = require("node:assert");
const { greet, isNewer, cachedGreet } = require("../dist/index.js");

test("greet includes the name", () => {
  assert.ok(greet("world").includes("Hello, world!"));
});

test("isNewer compares semver correctly", () => {
  assert.strictEqual(isNewer("2.0.0", "1.0.0"), true);
  assert.strictEqual(isNewer("1.0.0", "2.0.0"), false);
});

test("cachedGreet returns and caches a greeting", () => {
  const first = cachedGreet("alice");
  const second = cachedGreet("alice");
  assert.ok(first.includes("Hello, alice!"));
  assert.strictEqual(first, second);
});
