import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  listRepoFiles,
  readRepoFile,
  removeRepoFile,
  replaceRepoText,
  searchRepo,
  writeRepoFile,
} from "../src/tools/repo-files.ts";

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "depvisor-repo-tools-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git/config"), "[core]\n");
  return repo;
}

test("repo read tools list, search, and read bounded repository content", () => {
  const repo = repoWith({
    "src/a.ts": "export const alpha = 1;\nexport const beta = 2;\n",
    "README.md": "alpha docs\n",
  });
  const listed = listRepoFiles(repo);
  assert.equal(listed.truncated, false);
  assert.ok(listed.files.includes("src/a.ts"));
  assert.ok(!listed.files.some((path) => path.startsWith(".git/")));

  const search = searchRepo(repo, "alpha");
  assert.match(search.output, /src\/a\.ts:1:export const alpha/);
  assert.match(search.output, /README\.md:1:alpha docs/);

  assert.deepEqual(readRepoFile(repo, "src/a.ts", 2, 2), {
    path: "src/a.ts",
    content: "export const beta = 2;",
    truncated: true,
  });
});

test("repo write tools replace, create, and remove files inside the target", () => {
  const repo = repoWith({ "src/a.ts": "export const oldName = 1;\n" });
  replaceRepoText(repo, "src/a.ts", "oldName", "newName");
  assert.match(readFileSync(join(repo, "src/a.ts"), "utf8"), /newName/);

  writeRepoFile(repo, "src/new.ts", "export const added = true;\n");
  assert.equal(readFileSync(join(repo, "src/new.ts"), "utf8"), "export const added = true;\n");
  removeRepoFile(repo, "src/new.ts");
  assert.throws(() => readFileSync(join(repo, "src/new.ts"), "utf8"));
});

test("repo tools reject lexical, .git, absolute, and symlink escapes", () => {
  const repo = repoWith({ "src/a.ts": "safe\n" });
  const outside = mkdtempSync(join(tmpdir(), "depvisor-repo-tools-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(outside, join(repo, "outside-link"));
  symlinkSync(join(repo, ".git"), join(repo, "git-link"));

  for (const path of ["../escape", join(outside, "secret.txt"), ".git/config"]) {
    assert.throws(() => readRepoFile(repo, path), /repository|path|\.git/);
    assert.throws(() => writeRepoFile(repo, path, "evil\n"), /repository|path|\.git/);
  }
  assert.throws(() => readRepoFile(repo, "outside-link/secret.txt"), /outside/);
  assert.throws(() => writeRepoFile(repo, "outside-link/new.txt", "evil\n"), /outside/);
  assert.throws(() => readRepoFile(repo, "git-link/config"), /\.git/);
  assert.throws(() => writeRepoFile(repo, "git-link/config", "evil\n"), /\.git/);
});

test("replaceRepoText refuses absent or ambiguous edits", () => {
  const repo = repoWith({ "src/a.ts": "same\nsame\n" });
  assert.throws(() => replaceRepoText(repo, "src/a.ts", "missing", "x"), /not found/);
  assert.throws(() => replaceRepoText(repo, "src/a.ts", "same", "x"), /more than once/);
});
