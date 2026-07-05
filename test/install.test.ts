import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../src/core/install.ts";

test("runInstall maps a successful command to ok with its exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-install-"));
  const res = runInstall(dir, "exit 0");
  assert.deepEqual(res, { ok: true, code: 0 });
});

test("runInstall maps a failing command to not-ok with its exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-install-"));
  const res = runInstall(dir, "exit 3");
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.equal(res.error, undefined);
});

test("runInstall reports a command the shell cannot find as a plain failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "depvisor-install-"));
  const res = runInstall(dir, "depvisor-no-such-command-xyz");
  // With shell: true the shell itself launches fine and exits 127.
  assert.equal(res.ok, false);
  assert.equal(res.code, 127);
});
