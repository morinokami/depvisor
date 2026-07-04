import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidNpmName } from "./changelog.ts";
import type { Candidate, UpdateNarrative } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

export interface PrPayload {
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** One run prepares at most one PR, so the payload lives at a fixed name. */
export const PR_PAYLOAD_FILE = "payload.json";

function slugify(s: string): string {
  return s
    .replace(/@/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Branch name for a group: derived from the stable group key, never from the
 * member list. The key is the PR identity; member churn in e.g. `dev-minor`
 * must not change the branch.
 */
export function branchNameForGroup(groupKey: string): string {
  return `depvisor/${slugify(groupKey)}`;
}

/**
 * Machine-readable marker embedded in the PR body. A later run compares its
 * own target versions against the marker of the open PR on the same branch and
 * skips the whole agent run when nothing changed (idempotency and cost).
 */
export function versionsMarker(members: Pick<Candidate, "name" | "latest">[]): string {
  const list = members
    .map((m) => `${m.name}@${m.latest}`)
    .sort()
    .join(",");
  return `<!-- depvisor:versions=${list} -->`;
}

interface MarkdownSegment {
  code: boolean;
  text: string;
}

/**
 * Split markdown into code and plain-text segments. Code spans/fences are
 * inert in GitHub markdown and should not be escaped; unpaired backticks stay
 * plain text and are sanitized.
 */
function splitCodeSegments(s: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      segments.push({ code: false, text: plain });
      plain = "";
    }
  };
  let i = 0;
  while (i < s.length) {
    if (s.charAt(i) !== "`") {
      plain += s.charAt(i);
      i += 1;
      continue;
    }
    let j = i;
    while (j < s.length && s.charAt(j) === "`") j += 1;
    const run = j - i;
    let close = -1;
    let k = j;
    while (k < s.length) {
      if (s.charAt(k) !== "`") {
        k += 1;
        continue;
      }
      let m = k;
      while (m < s.length && s.charAt(m) === "`") m += 1;
      if (m - k === run) {
        close = k;
        break;
      }
      k = m;
    }
    if (close === -1) {
      plain += s.slice(i, j);
      i = j;
      continue;
    }
    flush();
    segments.push({ code: true, text: s.slice(i, close + run) });
    i = close + run;
  }
  flush();
  return segments;
}

/**
 * Sanitize one plain-text markdown segment:
 *   - strip hidden HTML comments,
 *   - escape `<` so raw HTML and angle-bracket autolinks cannot render,
 *   - escape the `[` in markdown images so they become plain text. Escaping
 *     `!` is insufficient because a prepended backslash can re-arm it,
 *   - defuse @mentions while preserving scoped package names like @types/node.
 */
function sanitizeText(s: string): string {
  return (
    s
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/</g, "&lt;")
      .replace(/!\[/g, "!\\[")
      // Lookahead excludes name chars too, so backtracking can't shorten
      // "@types" into a match for "@type" just because "/" follows.
      .replace(/@([A-Za-z0-9-]+)(?![A-Za-z0-9/-])/g, "@\u200b$1")
  );
}

/**
 * Sanitize agent-written narrative before it lands in a PR body, while leaving
 * code spans/fences intact.
 */
export function sanitizeSummary(s: string): string {
  return splitCodeSegments(s)
    .map((seg) => (seg.code ? seg.text : sanitizeText(seg.text)))
    .join("")
    .trim();
}

/** Strict marker shape: no chars that can close the comment or add structure. */
const VERSIONS_MARKER_RE = /<!-- depvisor:versions=[A-Za-z0-9@._,/~+-]* -->/;

/**
 * Exit-boundary sanitize for a full PR body. The tokenless step writes the
 * payload file, so the push step re-sanitizes it before passing it to `gh`.
 * The versions marker is the one HTML comment that must survive for idempotency;
 * only a strictly validated marker is extracted and re-appended.
 */
export function sanitizePrBody(body: string): string {
  const marker = body.match(VERSIONS_MARKER_RE)?.[0];
  const clean = sanitizeSummary(body);
  return marker ? `${clean}\n\n${marker}` : clean;
}

/** Render a titled bullet list, sanitizing items and collapsing newlines so an
 * item cannot escape its bullet and create markdown structure. */
function bulletSection(title: string, items: string[]): string {
  const bullets = items
    .map((i) => sanitizeSummary(i).replace(/\s*\n\s*/g, " "))
    .filter((i) => i.length > 0)
    .map((i) => `- ${i}`);
  return bullets.length > 0 ? `## ${title}\n\n${bullets.join("\n")}\n\n` : "";
}

// PR-body links are assembled only from strictly validated parts because the
// sanitizer intentionally leaves markdown links intact. Invalid parts drop the
// link; the table remains readable without it.
const GITHUB_SLUG_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const VERSION_RE = /^[A-Za-z0-9.+-]+$/;

/** Package cell: link valid npm names/versions, otherwise render a code span. */
function packageCell(c: Candidate): string {
  const label = `\`${c.name}\``;
  if (!isValidNpmName(c.name) || !VERSION_RE.test(c.latest)) return label;
  return `[${label}](https://www.npmjs.com/package/${c.name}/v/${c.latest})`;
}

/**
 * Source links for a package from its resolved GitHub slug: the releases page,
 * plus a compare link guessing the common `v`-prefixed tag convention — a wrong
 * guess lands on GitHub's empty-compare page, which is why it stays a guess
 * instead of costing API calls to verify tags.
 */
function linksCell(c: Candidate, slug: string | null | undefined): string {
  if (!slug || !GITHUB_SLUG_RE.test(slug)) return "";
  const links = [`[releases](https://github.com/${slug}/releases)`];
  if (VERSION_RE.test(c.current) && VERSION_RE.test(c.latest)) {
    links.push(`[compare](https://github.com/${slug}/compare/v${c.current}...v${c.latest})`);
  }
  return links.join(" · ");
}

/**
 * Assemble the PR payload from deterministic data plus the agent's structured
 * narrative. Every narrative field is untrusted and sanitized field-by-field.
 */
export function buildPrPayload(args: {
  branch: string;
  base: string;
  candidates: Candidate[];
  /** GitHub "owner/repo" per package; missing entries render without links. */
  sourceRepos?: ReadonlyMap<string, string | null>;
  narrative: UpdateNarrative;
  verification: VerifyResult[];
  diffStat: string;
}): PrPayload {
  const { branch, base, candidates, sourceRepos, narrative, verification, diffStat } = args;

  const title =
    candidates.length <= 3
      ? `deps: update ${candidates.map((c) => `${c.name} ${c.current} → ${c.latest}`).join(", ")}`
      : `deps: update ${candidates.map((c) => c.name).join(", ")}`;

  // The Links column only exists when at least one package resolved a source.
  const links = candidates.map((c) => linksCell(c, sourceRepos?.get(c.name)));
  const hasLinks = links.some((l) => l !== "");
  const versionTable = [
    `| Package | From | To |${hasLinks ? " Links |" : ""}`,
    `|---|---|---|${hasLinks ? "---|" : ""}`,
    ...candidates.map(
      (c, i) =>
        `| ${packageCell(c)} | ${c.current} | ${c.latest} |` +
        (hasLinks ? ` ${links[i] ?? ""} |` : ""),
    ),
  ].join("\n");

  // Drop notable-change entries for packages outside this PR's version table.
  const names = new Set(candidates.map((c) => c.name));
  const notable = narrative.notableChanges
    .filter((n) => names.has(n.package))
    .map((n) => `\`${n.package}\`: ${n.note}`);

  const checks = verification
    .map((v) => `- ${v.ok ? "✅" : "❌"} ${v.name} (exit ${v.code})`)
    .join("\n");

  const body = [
    "## What changed",
    "",
    sanitizeSummary(narrative.summary),
    "",
    bulletSection("Notable changes", notable) +
      bulletSection("Breaking changes addressed", narrative.breakingChangesAddressed) +
      bulletSection("Residual risks", narrative.residualRisks) +
      "## Packages",
    "",
    versionTable,
    "",
    "## Verification",
    "",
    checks,
    "",
    "## Diff",
    "",
    "```",
    diffStat.trim() || "(no diff)",
    "```",
    "",
    "---",
    "_Opened by depvisor. The final merge decision is yours._",
    "",
    versionsMarker(candidates),
  ].join("\n");

  return { branch, base, title, body };
}

/**
 * Emit the PR payload locally. The agent-facing workflow ALWAYS stops here —
 * pushing and opening the PR is a separate, token-holding step (`src/open-pr.ts`)
 * so the agent's execution environment never contains credentials.
 */
export function emitPrPayload(outDir: string, payload: PrPayload): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, PR_PAYLOAD_FILE);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}
