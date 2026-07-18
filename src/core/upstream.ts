/**
 * Bounded, unauthenticated upstream-evidence fetchers behind the agent tools.
 *
 * This module runs in the Flue process while the model works, so it must hold
 * no GitHub or registry credential, contact only fixed public hosts with
 * lexically validated coordinates, and cap everything it returns. Everything
 * fetched here is upstream project content: untrusted data, never authority.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { takeText } from "./context-budget.ts";
import { isRecord, str } from "./json.ts";
import { isSafeRepoPath } from "./paths.ts";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RELEASE_PAGES = 2;
const MAX_RELEASES = 20;
const MAX_RELEASE_BODY_CHARS = 3_000;
const MAX_TOTAL_NOTES_CHARS = 40_000;
const MAX_CHANGELOG_CHARS = 40_000;
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_TARBALL_ENTRIES = 20_000;
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

function parseOctal(field: Buffer): number {
  if (((field[0] ?? 0) & 0x80) !== 0) throw new Error("Unsupported tar size encoding.");
  const text = field.toString("ascii").replaceAll("\0", " ").trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid tar entry size.");
  return value;
}

function headerField(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function headerName(header: Buffer): string {
  const name = headerField(header, 0, 100);
  const prefix = headerField(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

/** Extract the `path` record from a pax extended header body, if present. */
function paxPath(body: Buffer): string | null {
  const text = body.toString("utf8");
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(" ", index);
    if (space === -1) return null;
    const length = Number.parseInt(text.slice(index, space), 10);
    if (!Number.isSafeInteger(length) || length <= space - index + 1) return null;
    const record = text.slice(space + 1, index + length);
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") {
      return record.slice(equals + 1).replace(/\n$/, "");
    }
    index += length;
  }
  return null;
}

/** Drop the tarball's single top-level directory (usually `package/`). */
function stripPackagePrefix(name: string): string | null {
  const normalized = name.startsWith("./") ? name.slice(2) : name;
  const slash = normalized.indexOf("/");
  if (slash === -1) return null;
  const rest = normalized.slice(slash + 1);
  return rest || null;
}

/**
 * Read regular files out of a gzipped npm tarball without executing tar.
 * Unsafe paths and every non-file entry (symlinks included) are dropped, so
 * nothing extracted here can escape or alias the comparison directory.
 */
export function extractPackageFiles(tarball: Buffer): Map<string, Buffer> {
  const data = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files = new Map<string, Buffer>();
  let offset = 0;
  let entries = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > MAX_TARBALL_ENTRIES) throw new Error("The package tarball has too many entries.");
    const size = parseOctal(header.subarray(124, 136));
    const body = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const typeflag = header[156] ?? 0;
    if (typeflag === 0x4c) {
      pendingLongName = body.toString("utf8").replaceAll("\0", "");
      continue;
    }
    if (typeflag === 0x78) {
      pendingPaxPath = paxPath(body);
      continue;
    }
    if (typeflag === 0x67) continue;
    const name = pendingPaxPath ?? pendingLongName ?? headerName(header);
    pendingLongName = null;
    pendingPaxPath = null;
    if (typeflag !== 0x30 && typeflag !== 0) continue;
    const relative = stripPackagePrefix(name);
    if (relative === null || !isSafeRepoPath(relative)) continue;
    files.set(relative, Buffer.from(body));
  }
  return files;
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("The tarball response had no body.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
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
  const before = await downloadPackage(name, fromVersion, options);
  const after = await downloadPackage(name, toVersion, options);

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

  const root = mkdtempSync(join(tmpdir(), "depvisor-npm-diff-"));
  let diffText: string;
  try {
    writeTree(join(root, "a"), before);
    writeTree(join(root, "b"), after);
    diffText = runSystemDiff(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

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
