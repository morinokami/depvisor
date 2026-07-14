import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchReleaseNotes,
  isValidNpmName,
  parseGithubSlug,
  sanitizeReleaseText,
  selectReleases,
} from "../src/core/changelog.ts";

test("release-note coordinates cannot smuggle an endpoint", () => {
  assert.equal(isValidNpmName("@scope/package"), true);
  assert.equal(isValidNpmName("../../metadata"), false);
  assert.equal(isValidNpmName("https://example.com/x"), false);
  assert.equal(parseGithubSlug("git+https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseGithubSlug("https://example.com/owner/repo"), null);
});

test("untrusted release text is sanitized, windowed, and bounded", () => {
  assert.equal(sanitizeReleaseText("before<!-- ignore me -->after"), "beforeafter");
  assert.ok(sanitizeReleaseText("x".repeat(10_000)).length < 5_000);
  const releases = selectReleases(
    [
      { tag_name: "v2.0.0", body: "target", draft: false, prerelease: false },
      { tag_name: "v1.5.0", body: "middle", draft: false, prerelease: false },
      { tag_name: "v1.4.0", body: "old", draft: false, prerelease: false },
      { tag_name: "v1.6.0-beta.1", body: "beta", draft: false, prerelease: true },
    ],
    "1.4.0",
    "2.0.0",
  );
  assert.deepEqual(
    releases.map((release) => release.notes),
    ["target", "middle"],
  );
});

test("release-note collection fixes the GitHub endpoint and degrades on failure", async () => {
  const urls: string[] = [];
  const result = await fetchReleaseNotes(
    { package: "example", from: "1.0.0", to: "2.0.0" },
    {
      slug: "owner/repo",
      fetch: async (input) => {
        urls.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return new Response(
          JSON.stringify([{ tag_name: "v2.0.0", body: "notes", draft: false, prerelease: false }]),
          { status: 200 },
        );
      },
    },
  );
  assert.deepEqual(urls, ["https://api.github.com/repos/owner/repo/releases?per_page=100"]);
  assert.equal(result.releases[0]?.notes, "notes");

  const unavailable = await fetchReleaseNotes(
    { package: "not valid/url", from: "1.0.0", to: "2.0.0" },
    { fetch: async () => new Response(null, { status: 500 }) },
  );
  assert.deepEqual(unavailable.releases, []);
});
