import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  diffNpmPackage,
  extractPackageFiles,
  fetchReleaseNotes,
  isGitHubRepository,
  isNpmPackageName,
  isVersionToken,
} from "../src/core/upstream.ts";

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  return header;
}

function tarEntry(name: string, content: string, typeflag = "0"): Buffer {
  const body = Buffer.from(content, "utf8");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([tarHeader(name, body.length, typeflag), padded]);
}

function tarball(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    for (const [prefix, make] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return make();
    }
    return new Response("not found", { status: 404 });
  };
}

test("validates upstream coordinates lexically", () => {
  assert.equal(isGitHubRepository("webpro-nl/knip"), true);
  assert.equal(isGitHubRepository(".github/workflows"), true);
  for (const repo of ["", "knip", "a/b/c", "../x", "a/..", "a/", "a/b?x=1", "a/b#f", "a/b c"]) {
    assert.equal(isGitHubRepository(repo), false, repo);
  }
  assert.equal(isNpmPackageName("knip"), true);
  assert.equal(isNpmPackageName("@scope/pkg-name"), true);
  assert.equal(isNpmPackageName("JSONStream"), true);
  for (const name of ["", ".hidden", "_private", "a/b", "@S/pkg", "a b", `x${"y".repeat(214)}`]) {
    assert.equal(isNpmPackageName(name), false, name);
  }
  assert.equal(isVersionToken("6.25.0"), true);
  assert.equal(isVersionToken("1.0.0-rc.1+build"), true);
  for (const version of ["", "-1", "1/2", "1.0 ", "v".repeat(65)]) {
    assert.equal(isVersionToken(version), false, JSON.stringify(version));
  }
});

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

test("fetches and filters GitHub releases", async () => {
  const releases = [
    {
      tag_name: "knip@6.25.0",
      name: "knip@6.25.0",
      published_at: "2026-06-01T00:00:00Z",
      html_url: "https://github.com/webpro-nl/knip/releases/tag/knip%406.25.0",
      body: "notes for 6.25.0",
    },
    {
      tag_name: "other@1.0.0",
      name: "other@1.0.0",
      published_at: "2026-05-01T00:00:00Z",
      html_url: "https://example.invalid",
      body: "unrelated",
    },
  ];
  const result = await fetchReleaseNotes("webpro-nl/knip", "knip@6.", {
    fetchImpl: stubFetch({
      "https://api.github.com/repos/webpro-nl/knip/releases": () =>
        new Response(JSON.stringify(releases), { status: 200 }),
    }),
  });
  assert.equal(result.source, "github-releases");
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0]?.tag, "knip@6.25.0");
  assert.equal(result.releases[0]?.body, "notes for 6.25.0");
});

test("falls back to CHANGELOG.md when the releases API is unavailable", async () => {
  const result = await fetchReleaseNotes("owner/repo", "", {
    fetchImpl: stubFetch({
      "https://api.github.com/repos/owner/repo/releases": () =>
        new Response("rate limited", { status: 403 }),
      "https://raw.githubusercontent.com/owner/repo/HEAD/CHANGELOG.md": () =>
        new Response("# Changelog\n\n## 2.0.0\n", { status: 200 }),
    }),
  });
  assert.equal(result.source, "changelog-file");
  assert.match(result.changelog, /## 2\.0\.0/);
  assert.match(result.note, /403/);
});

test("reports when no upstream notes could be fetched", async () => {
  const result = await fetchReleaseNotes("owner/repo", "", {
    fetchImpl: stubFetch({}),
  });
  assert.equal(result.source, "none");
  assert.equal(result.releases.length, 0);
  assert.match(result.note, /do not state release content/);
});

test("rejects an invalid repository coordinate", async () => {
  await assert.rejects(fetchReleaseNotes("owner/../evil", ""), /owner\/name/);
});

test("diffs two published npm versions with bounded output", async () => {
  const from = tarball([
    tarEntry("package/index.js", "old\n"),
    tarEntry("package/removed.txt", "gone\n"),
    tarEntry("package/same.txt", "same\n"),
  ]);
  const to = tarball([
    tarEntry("package/index.js", "new\n"),
    tarEntry("package/added.txt", "fresh\n"),
    tarEntry("package/same.txt", "same\n"),
  ]);
  const fetchImpl = stubFetch({
    "https://registry.npmjs.org/demo/1.0.0": () =>
      new Response(
        JSON.stringify({ dist: { tarball: "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz" } }),
        { status: 200 },
      ),
    "https://registry.npmjs.org/demo/2.0.0": () =>
      new Response(
        JSON.stringify({ dist: { tarball: "https://registry.npmjs.org/demo/-/demo-2.0.0.tgz" } }),
        { status: 200 },
      ),
    "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz": () => new Response(new Uint8Array(from)),
    "https://registry.npmjs.org/demo/-/demo-2.0.0.tgz": () => new Response(new Uint8Array(to)),
  });
  const result = await diffNpmPackage("demo", "1.0.0", "2.0.0", { fetchImpl });
  assert.deepEqual(result.addedFiles, ["added.txt"]);
  assert.deepEqual(result.removedFiles, ["removed.txt"]);
  assert.deepEqual(result.modifiedFiles, ["index.js"]);
  assert.equal(result.fileListTruncated, false);
  assert.match(result.diff, /-old/);
  assert.match(result.diff, /\+new/);
  assert.match(result.diff, /added\.txt/);
});

test("rejects tarball locations outside the npm registry", async () => {
  const fetchImpl = stubFetch({
    "https://registry.npmjs.org/demo/1.0.0": () =>
      new Response(JSON.stringify({ dist: { tarball: "https://evil.invalid/demo.tgz" } }), {
        status: 200,
      }),
  });
  await assert.rejects(
    diffNpmPackage("demo", "1.0.0", "2.0.0", { fetchImpl }),
    /unexpected tarball location/,
  );
});

test("rejects non-literal npm coordinates", async () => {
  await assert.rejects(diffNpmPackage("../evil", "1.0.0", "2.0.0"), /package name/);
  await assert.rejects(diffNpmPackage("demo", "1.0.0/x", "2.0.0"), /version/);
});
