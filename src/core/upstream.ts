/**
 * Bounded, unauthenticated upstream-evidence fetchers behind the agent tools.
 *
 * This module runs in the Flue process while the model works, so it must hold
 * no GitHub or registry credential, contact only fixed public hosts with
 * lexically validated coordinates, and cap everything it returns. Everything
 * fetched here is upstream project content: untrusted data, never instructions
 * to follow.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { takeText } from "./context-budget.ts";
import { isRecord, str } from "./json.ts";
import { extractPackageFiles } from "./tar.ts";
import { tempDir } from "./temp.ts";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RELEASE_PAGES = 2;
const MAX_RELEASES = 20;
const MAX_RELEASE_BODY_CHARS = 3_000;
const MAX_TOTAL_NOTES_CHARS = 40_000;
const MAX_CHANGELOG_CHARS = 40_000;
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
const MAX_LISTED_FILES = 200;
const MAX_DIFF_CHARS = 40_000;

export interface UpstreamOptions {
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Accept only literal owner/name pairs that cannot alter the request path. */
export function isGitHubRepository(value: string): boolean {
  const segments = value.split("/");
  if (segments.length !== 2) return false;
  return segments.every(
    (segment) => GITHUB_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..",
  );
}

const NPM_NAME_PATTERN = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*$/;

export function isNpmPackageName(value: string): boolean {
  return value.length <= 214 && NPM_NAME_PATTERN.test(value);
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

export function isVersionToken(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

export type ReleaseNote = {
  tag: string;
  title: string;
  publishedAt: string;
  url: string;
  body: string;
};

export type ReleaseNotesResult = {
  source: "github-releases" | "changelog-file" | "none";
  releases: ReleaseNote[];
  changelogUrl: string;
  changelog: string;
  note: string;
};

/**
 * Fetch published GitHub releases unauthenticated, falling back to the
 * repository's CHANGELOG.md head when the API yields nothing usable.
 */
export async function fetchReleaseNotes(
  repository: string,
  filter: string,
  options: UpstreamOptions = {},
): Promise<ReleaseNotesResult> {
  if (!isGitHubRepository(repository)) {
    throw new Error('Pass the upstream GitHub repository as "owner/name".');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const wanted = filter.trim().slice(0, 100).toLowerCase();
  const releases: ReleaseNote[] = [];
  const budget = { remaining: MAX_TOTAL_NOTES_CHARS };
  let apiNote = "";
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    let raw: unknown;
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "depvisor",
            "x-github-api-version": "2022-11-28",
          },
          signal: requestSignal(options.signal),
        },
      );
      if (!response.ok) {
        apiNote = `The GitHub releases API returned ${response.status} (unauthenticated requests are rate-limited).`;
        break;
      }
      raw = await response.json();
    } catch (error: unknown) {
      apiNote = `The GitHub releases request failed: ${String(error)}`;
      break;
    }
    if (!Array.isArray(raw)) {
      apiNote = "GitHub returned an invalid release list.";
      break;
    }
    for (const value of raw) {
      if (!isRecord(value)) continue;
      const tag = str(value.tag_name);
      const title = str(value.name);
      if (wanted && !tag.toLowerCase().includes(wanted) && !title.toLowerCase().includes(wanted)) {
        continue;
      }
      releases.push({
        tag,
        title,
        publishedAt: str(value.published_at),
        url: str(value.html_url),
        body: takeText(str(value.body), MAX_RELEASE_BODY_CHARS, budget),
      });
      if (releases.length >= MAX_RELEASES || budget.remaining <= 0) break;
    }
    if (releases.length >= MAX_RELEASES || budget.remaining <= 0 || raw.length < 100) break;
  }
  if (releases.length > 0) {
    return { source: "github-releases", releases, changelogUrl: "", changelog: "", note: apiNote };
  }

  const changelogUrl = `https://raw.githubusercontent.com/${repository}/HEAD/CHANGELOG.md`;
  let fallbackNote = "";
  try {
    const response = await fetchImpl(changelogUrl, {
      headers: { "user-agent": "depvisor" },
      signal: requestSignal(options.signal),
    });
    if (response.ok) {
      return {
        source: "changelog-file",
        releases: [],
        changelogUrl,
        changelog: (await response.text()).slice(0, MAX_CHANGELOG_CHARS),
        note: [apiNote, "No matching GitHub release; returning the head of CHANGELOG.md instead."]
          .filter(Boolean)
          .join(" "),
      };
    }
    fallbackNote = `The CHANGELOG.md fallback returned ${response.status}.`;
  } catch (error: unknown) {
    fallbackNote = `The CHANGELOG.md fallback failed: ${String(error)}`;
  }
  return {
    source: "none",
    releases: [],
    changelogUrl: "",
    changelog: "",
    note: [
      apiNote,
      fallbackNote,
      "No upstream notes could be fetched; do not state release content you have not seen.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("The tarball response had no body.");
  const chunks: Buffer[] = [];
  let total = 0;
  // Throwing out of the loop cancels the stream via the async iterator's return().
  for await (const value of response.body) {
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`The package tarball exceeds depvisor's ${maxBytes}-byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function downloadPackage(
  name: string,
  version: string,
  options: UpstreamOptions,
): Promise<Map<string, Buffer>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetchImpl(manifestUrl, {
    headers: { accept: "application/json", "user-agent": "depvisor" },
    signal: requestSignal(options.signal),
  });
  if (!response.ok) {
    throw new Error(`The npm registry returned ${response.status} for ${name}@${version}.`);
  }
  const manifest: unknown = await response.json();
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.dist) ||
    typeof manifest.dist.tarball !== "string"
  ) {
    throw new Error(`The npm registry returned no tarball URL for ${name}@${version}.`);
  }
  const tarball = new URL(manifest.dist.tarball);
  if (tarball.protocol !== "https:" || tarball.hostname !== "registry.npmjs.org") {
    throw new Error("The npm registry returned an unexpected tarball location.");
  }
  const download = await fetchImpl(tarball.href, {
    headers: { "user-agent": "depvisor" },
    signal: requestSignal(options.signal),
  });
  if (!download.ok) {
    throw new Error(`The tarball download for ${name}@${version} returned ${download.status}.`);
  }
  return extractPackageFiles(await readCapped(download, MAX_TARBALL_BYTES));
}

function writeTree(root: string, files: Map<string, Buffer>): void {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function runSystemDiff(root: string): string {
  try {
    execFileSync("diff", ["-r", "-u", "-N", "a", "b"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return "";
  } catch (error: unknown) {
    if (isRecord(error) && error.status === 1 && typeof error.stdout === "string") {
      return error.stdout;
    }
    throw new Error("The system diff command failed while comparing package contents.", {
      cause: error,
    });
  }
}

export type PackageDiffResult = {
  package: string;
  fromVersion: string;
  toVersion: string;
  addedFiles: string[];
  removedFiles: string[];
  modifiedFiles: string[];
  fileListTruncated: boolean;
  diff: string;
  diffTruncated: boolean;
};

/**
 * Compare the published contents of two npm versions and return a bounded
 * file summary plus a capped unified diff.
 */
export async function diffNpmPackage(
  name: string,
  fromVersion: string,
  toVersion: string,
  options: UpstreamOptions = {},
): Promise<PackageDiffResult> {
  if (!isNpmPackageName(name)) throw new Error("Pass a literal npm package name.");
  if (!isVersionToken(fromVersion) || !isVersionToken(toVersion)) {
    throw new Error("Pass exact published version strings.");
  }
  const [before, after] = await Promise.all([
    downloadPackage(name, fromVersion, options),
    downloadPackage(name, toVersion, options),
  ]);

  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  for (const path of [...after.keys()].toSorted()) {
    const next = after.get(path);
    if (next === undefined) continue;
    const previous = before.get(path);
    if (previous === undefined) addedFiles.push(path);
    else if (!previous.equals(next)) modifiedFiles.push(path);
  }
  const removedFiles = [...before.keys()].filter((path) => !after.has(path)).toSorted();

  using root = tempDir("depvisor-npm-diff-");
  writeTree(join(root.path, "a"), before);
  writeTree(join(root.path, "b"), after);
  const diffText = runSystemDiff(root.path);

  const fileListTruncated =
    addedFiles.length > MAX_LISTED_FILES ||
    removedFiles.length > MAX_LISTED_FILES ||
    modifiedFiles.length > MAX_LISTED_FILES;
  return {
    package: name,
    fromVersion,
    toVersion,
    addedFiles: addedFiles.slice(0, MAX_LISTED_FILES),
    removedFiles: removedFiles.slice(0, MAX_LISTED_FILES),
    modifiedFiles: modifiedFiles.slice(0, MAX_LISTED_FILES),
    fileListTruncated,
    diff: diffText.slice(0, MAX_DIFF_CHARS),
    diffTruncated: diffText.length > MAX_DIFF_CHARS,
  };
}
