import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmToolchain, pnpmToolchain } from "../src/core/pm.ts";
import { parseVerifyCommands, runVerification, verifyStepsFor } from "../src/core/verify.ts";

test("parseVerifyCommands: one command per line, trimmed, blanks dropped", () => {
  assert.deepEqual(parseVerifyCommands("npm run check\n\n  npm run test:unit  \n"), [
    { name: "npm run check", run: "npm run check" },
    { name: "npm run test:unit", run: "npm run test:unit" },
  ]);
});

test("parseVerifyCommands: CRLF input (GitHub Actions multi-line values)", () => {
  assert.deepEqual(parseVerifyCommands("make lint\r\nmake test\r\n"), [
    { name: "make lint", run: "make lint" },
    { name: "make test", run: "make test" },
  ]);
});

test("parseVerifyCommands: empty/whitespace-only means unset", () => {
  assert.deepEqual(parseVerifyCommands(""), []);
  assert.deepEqual(parseVerifyCommands("  \n \r\n"), []);
});

test("verifyStepsFor: detects known scripts in gate order, ignores the rest", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-verify-"));
  // typecheck is opt-in through verify_commands; build is the stronger default.
  writeFileSync(
    join(repo, "package.json"),
    `{"scripts":{"test":"node --test","lint":"oxlint","typecheck":"tsc --noEmit","deploy":"sh deploy.sh"}}`,
  );
  assert.deepEqual(verifyStepsFor(repo, npmToolchain), [
    { name: "lint", run: "npm run lint" },
    { name: "test", run: "npm run test" },
  ]);
});

test("verifyStepsFor: runs scripts through the detected package manager", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-verify-"));
  writeFileSync(join(repo, "package.json"), `{"scripts":{"build":"tsc","test":"node --test"}}`);
  assert.deepEqual(verifyStepsFor(repo, pnpmToolchain), [
    { name: "build", run: "pnpm run build" },
    { name: "test", run: "pnpm run test" },
  ]);
});

test("verifyStepsFor: no package.json means no steps", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-verify-"));
  assert.deepEqual(verifyStepsFor(repo, npmToolchain), []);
});

test("runVerification: runs steps in order and reports exit codes", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-verify-"));
  const results = runVerification(repo, [
    { name: "ok", run: `node -e "process.exit(0)"` },
    { name: "also-ok", run: `node -e "process.exit(0)"` },
  ]);
  assert.deepEqual(results, [
    { name: "ok", ok: true, code: 0 },
    { name: "also-ok", ok: true, code: 0 },
  ]);
});

test("runVerification: first failure stops the gate", () => {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-verify-"));
  const results = runVerification(repo, [
    { name: "fails", run: `node -e "process.exit(3)"` },
    { name: "never-runs", run: `node -e "process.exit(0)"` },
  ]);
  assert.deepEqual(results, [{ name: "fails", ok: false, code: 3 }]);
});
