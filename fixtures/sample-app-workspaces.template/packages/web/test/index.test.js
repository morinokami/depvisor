const test = require("node:test");
const assert = require("node:assert");
const { greet, versionLabel } = require("../dist/index.js");

test("greet includes the name", () => {
  assert.ok(greet("world").includes("Hello, world!"));
});

test("versionLabel returns a string for both branches", () => {
  assert.strictEqual(typeof versionLabel("2.0.0", "1.0.0"), "string");
  assert.strictEqual(typeof versionLabel("1.0.0", "2.0.0"), "string");
});
