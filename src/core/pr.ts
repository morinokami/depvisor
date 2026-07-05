import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidNpmName } from "./changelog.ts";
import { RUN_STATUS_FILE } from "./status-file.ts";
import type { Candidate, UpdateNarrative } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

export interface PrPayload {
  branch: string;
  base: string;
  title: string;
  body: string;
}

/**
 * A run prepares one payload per prepared PR, under this directory in the
 * pr-preview output. Filenames are `<NN>-<slug>.json` (processing order, then
 * the branch slug), so the token-holding open-pr step enumerates them
 * deterministically in order.
 */
export const PR_PAYLOADS_DIR = "payloads";

export function slugify(s: string): string {
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
 * Machine-readable marker embedded in the PR body. A later run compares its own
 * targets against the marker of the open PR on the same branch and skips the
 * whole agent run when nothing changed (idempotency and cost).
 *
 * Each member is encoded as `name@latest@<workspaces>` (its declaring
 * workspaces, sorted, `~`-joined; the root is ""). The workspaces are part of
 * the key on purpose: in a monorepo the same `name@latest` can newly apply to
 * an additional workspace, and an open PR that updated fewer workspaces than the
 * current run must NOT be treated as up to date — otherwise the extra workspace
 * is silently skipped. All parts stay within VERSIONS_MARKER_RE's charset (paths
 * use `/` and `-`, never `~`), so the marker survives exit-boundary sanitizing.
 */
export function versionsMarker(
  members: Pick<Candidate, "name" | "latest" | "locations">[],
): string {
  const list = members
    .map((m) => `${m.name}@${m.latest}@${[...m.locations].sort().join("~")}`)
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
const DEPVISOR_REPO_URL = "https://github.com/morinokami/depvisor";

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
}): PrPayload {
  const { branch, base, candidates, sourceRepos, narrative, verification } = args;

  const title =
    candidates.length <= 3
      ? `deps: update ${candidates.map((c) => `${c.name} ${c.current} to ${c.latest}`).join(", ")}`
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

  const narrativeSections =
    bulletSection("Notable changes", notable) +
    bulletSection("Breaking changes addressed", narrative.breakingChangesAddressed) +
    bulletSection("Residual risks", narrative.residualRisks);

  const body = [
    "This PR updates the following packages:",
    "",
    versionTable,
    "",
    "## What changed",
    "",
    sanitizeSummary(narrative.summary),
    "",
    narrativeSections + "## Verification",
    "",
    checks,
    "",
    "---",
    `_Opened by [depvisor](${DEPVISOR_REPO_URL})._`,
    "",
    versionsMarker(candidates),
  ].join("\n");

  return { branch, base, title, body };
}

/**
 * Emit one PR payload locally under `<outDir>/payloads/<NN>-<slug>.json`, where
 * `NN` is the zero-padded processing order and `slug` is the branch slug. The
 * agent-facing workflow ALWAYS stops here — pushing and opening the PR is a
 * separate, token-holding step (`src/open-pr.ts`) so the agent's execution
 * environment never contains credentials.
 */
export function emitPrPayload(outDir: string, payload: PrPayload, index: number): string {
  const dir = join(outDir, PR_PAYLOADS_DIR);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${String(index).padStart(2, "0")}-${slugify(payload.branch)}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

/**
 * Remove prior-run output before a new run: the payloads directory and the
 * status file. Without this a stale payload from a previous local run would be
 * pushed by open-pr, and old per-group payloads would accumulate across runs
 * (their filenames differ, so writing new ones does not overwrite them). Runs in
 * deterministic code before the agent. In CI the checkout is fresh each run, so
 * this only matters for repeated local runs — but the failure mode (pushing a
 * stale branch) is bad enough to clear unconditionally.
 */
export function clearPrPreview(outDir: string): void {
  rmSync(join(outDir, PR_PAYLOADS_DIR), { recursive: true, force: true });
  rmSync(join(outDir, RUN_STATUS_FILE), { force: true });
}
