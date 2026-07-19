import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPackageFiles } from "../src/core/tar.ts";
import { tarEntry, tarball } from "./tar-fixture.ts";

test("extracts only safe regular files and strips the package prefix", () => {
  const files = extractPackageFiles(
    tarball([
      tarEntry("package/index.js", "console.log(1)\n"),
      tarEntry("package/lib/util.js", "util\n"),
      tarEntry("package/../evil.txt", "escape\n"),
      tarEntry("toplevel.txt", "no prefix\n"),
      tarEntry("package/link", "target", "2"),
      tarEntry("package/dir/", "", "5"),
    ]),
  );
  assert.deepEqual([...files.keys()].toSorted(), ["index.js", "lib/util.js"]);
  assert.equal(files.get("index.js")?.toString("utf8"), "console.log(1)\n");
});

test("honors GNU long names before the following entry", () => {
  const longName = `package/${"deep/".repeat(24)}leaf.txt`;
  const files = extractPackageFiles(
    tarball([
      tarEntry("././@LongLink", `${longName}\0`, "L"),
      tarEntry("package/truncated", "long content\n"),
    ]),
  );
  assert.deepEqual([...files.keys()], [longName.slice("package/".length)]);
  assert.equal(files.get(longName.slice("package/".length))?.toString("utf8"), "long content\n");
});
