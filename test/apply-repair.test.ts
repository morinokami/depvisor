import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeNewRepairFiles } from "../src/core/apply-repair.ts";

test("writes a captured new file under real directories", () => {
  const root = mkdtempSync(join(tmpdir(), "depvisor-apply-"));
  materializeNewRepairFiles(root, [
    {
      path: "nested/file.txt",
      contentBase64: Buffer.from("content\n").toString("base64"),
      executable: false,
      symlink: false,
    },
  ]);
  assert.equal(readFileSync(join(root, "nested/file.txt"), "utf8"), "content\n");
});

test("refuses to write through a symlink parent", () => {
  const root = mkdtempSync(join(tmpdir(), "depvisor-apply-"));
  const outside = mkdtempSync(join(tmpdir(), "depvisor-outside-"));
  symlinkSync(outside, join(root, "escape"));
  assert.throws(
    () =>
      materializeNewRepairFiles(root, [
        {
          path: "escape/file.txt",
          contentBase64: Buffer.from("content\n").toString("base64"),
          executable: false,
          symlink: false,
        },
      ]),
    /symlink parent/,
  );
});
