/** Rendering boundaries for agent-authored and otherwise untrusted text. */

import { isSafeRepoPath } from "./paths.ts";

// oxlint-disable no-control-regex -- normalize control bytes at a rendering boundary
function inline(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, max)
    .trim();
}
// oxlint-enable no-control-regex

/** Preserve ordinary punctuation while preventing marker injection in the PR report. */
export function cleanReportText(value: string, max = 4_000): string {
  return inline(value, max).replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
}

const SERVER_PATTERN = /^https:\/\/[A-Za-z0-9._-]+(?::\d+)?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Build one https://…/actions/runs/<id> URL from validated components only. */
export function actionsRunUrl(server: string, repository: string, runId: number): string | null {
  if (!SERVER_PATTERN.test(server)) return null;
  if (!REPOSITORY_PATTERN.test(repository)) return null;
  if (!Number.isSafeInteger(runId) || runId <= 0) return null;
  return `${server}/${repository}/actions/runs/${runId}`;
}

/**
 * Build a blob URL pinned to one commit for a lexically safe repository path.
 * Every component except the path is publisher-derived; a component that fails
 * its shape check yields no URL rather than a loosely built one.
 */
export function repoFileUrl(
  server: string,
  repository: string,
  sha: string,
  path: string,
): string | null {
  if (!SERVER_PATTERN.test(server)) return null;
  if (!REPOSITORY_PATTERN.test(repository)) return null;
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  if (!isSafeRepoPath(path)) return null;
  let encoded: string;
  try {
    // encodeURIComponent throws on lone surrogates; an unencodable path gets no link.
    encoded = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
  encoded = encoded.replaceAll("(", "%28").replaceAll(")", "%29");
  return `${server}/${repository}/blob/${sha}/${encoded}`;
}

const CODE_SPAN = /`([^`\n]{1,256})`/g;

/**
 * Turn backticked file mentions in untrusted report prose into Markdown links.
 * Only lexically safe repository-relative tokens reach `link`; a null return
 * (unknown file, unlinkable component) leaves the mention as literal text.
 */
export function linkifyRepoPaths(text: string, link: (path: string) => string | null): string {
  return text.replace(CODE_SPAN, (span, token: string) => {
    if (!isSafeRepoPath(token)) return span;
    const url = link(token);
    return url === null ? span : `[\`${token}\`](${url})`;
  });
}

/** Render a single untrusted value as literal inline text in a step summary. */
export function escapeStepSummaryText(value: string, max = 2_000): string {
  const html = inline(value, max)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  let escaped = html;
  for (const character of [
    "\\",
    "`",
    "*",
    "_",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "#",
    "+",
    "-",
    ".",
    "!",
    "|",
    "~",
  ]) {
    escaped = escaped.replaceAll(character, `\\${character}`);
  }
  return escaped;
}
