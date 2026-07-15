import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidNpmName } from "./changelog.ts";
import type { NumstatEntry } from "./git.ts";
import { RUN_STATUS_FILE } from "./status-file.ts";
import { formatNumstatLines } from "./test-changes.ts";
import type { DependencyChange, NotableChange, UpdateNarrative } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

/**
 * The reviewer report and the publish payload — v2's only outward-facing
 * artifacts. depvisor no longer opens PRs or writes PR titles/bodies; it
 * publishes at most one repair commit onto the updater's own branch plus one
 * marker-deduplicated report comment on the updater's PR. This module renders
 * that comment deterministically (sanitizing every untrusted, agent- or
 * registry-derived fragment) and shapes the payload the token-holding publish
 * step consumes.
 */

/**
 * What the token-holding publish step needs. The PR identity (number, head
 * ref) is ALSO passed to that step through trusted action env — the payload
 * copy exists for local inspection and cross-checking, and the publish step
 * refuses when the two disagree, because this file is an untrusted read-back
 * at that boundary (the tokenless step wrote it).
 */
export interface ReportPayload {
  /** The PR number the report comment lands on; null only in local dev runs. */
  prNumber: number | null;
  /** The updater's branch — the push target when a repair commit exists. */
  headRef: string;
  baseRef: string;
  /**
   * The updater tip this run consumed. The publish step pushes only when the
   * remote head still equals it (compare-and-swap): if the updater rebased or
   * a human pushed mid-run, publishing is blocked instead of clobbering.
   */
  expectedHeadSha: string;
  /** The local repair commit to fast-forward-push, or null (report only). */
  repairSha: string | null;
  /** The full report comment markdown, ending with the aftercare marker. */
  commentBody: string;
}

/** The payload filename under the pr-preview output directory. */
export const REPORT_PAYLOAD_FILE = "payload.json";

/**
 * The git bundle carrying the repair commits (`expectedHeadSha..repairSha`)
 * from the analyze job to the publish job. Written by `bundle-payload.ts`,
 * consumed — as untrusted input, re-verified structurally — by the publish
 * step.
 */
export const REPAIR_BUNDLE_FILE = "repair.bundle";

/**
 * Read-back shape validation for the payload file. The tokenless step wrote
 * it, so the token-holding publish step must not assume its shape: a
 * JSON-parseable but non-payload file (`{}`, a bare string, a mistyped field)
 * would otherwise throw deep inside the push path. Shape only, rebuilt
 * field-by-field so extra keys are dropped — content stays re-validated at the
 * exit boundary (sanitizeCommentBody, and the publish step's trusted-env
 * cross-checks). Returns null when the shape is wrong.
 */
export function parseReportPayload(raw: unknown): ReportPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Partial<ReportPayload>;
  if (typeof p.headRef !== "string" || !p.headRef) return null;
  if (typeof p.baseRef !== "string" || !p.baseRef) return null;
  if (typeof p.expectedHeadSha !== "string" || !/^[0-9a-f]{40}$/.test(p.expectedHeadSha)) {
    return null;
  }
  if (typeof p.commentBody !== "string") return null;
  if (p.repairSha !== null && typeof p.repairSha !== "string") return null;
  const repairSha =
    typeof p.repairSha === "string" && /^[0-9a-f]{40}$/.test(p.repairSha) ? p.repairSha : null;
  if (typeof p.repairSha === "string" && repairSha === null) return null;
  if (p.prNumber !== null && typeof p.prNumber !== "number") return null;
  const prNumber =
    typeof p.prNumber === "number" && Number.isSafeInteger(p.prNumber) && p.prNumber > 0
      ? p.prNumber
      : null;
  if (typeof p.prNumber === "number" && prNumber === null) return null;
  return {
    prNumber,
    headRef: p.headRef,
    baseRef: p.baseRef,
    expectedHeadSha: p.expectedHeadSha,
    repairSha,
    commentBody: p.commentBody,
  };
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
      .replaceAll("<", "&lt;")
      .replaceAll("![", "!\\[")
      // Lookahead excludes name chars too, so backtracking can't shorten
      // "@types" into a match for "@type" just because "/" follows.
      .replace(/@([A-Za-z0-9-]+)(?![A-Za-z0-9/-])/g, "@\u200b$1")
  );
}

/**
 * Sanitize agent-written narrative before it lands in the report comment,
 * while leaving code spans/fences intact.
 */
export function sanitizeSummary(s: string): string {
  return splitCodeSegments(s)
    .map((seg) => (seg.code ? seg.text : sanitizeText(seg.text)))
    .join("")
    .trim();
}

/**
 * The fixed marker that makes the report comment idempotent: the publish step
 * finds and edits the existing marker-carrying comment instead of stacking a
 * new one per run. Fixed-string, no run data, so a PR carries at most one.
 */
export const AFTERCARE_MARKER = "<!-- depvisor:aftercare -->";

// End-anchored (trailing whitespace tolerated for CRLF/web-edited bodies):
// buildReportComment writes the marker as the body's last line, so the
// authentic marker is only ever the trailing one.
const TRAILING_MARKER_RE = /<!-- depvisor:aftercare -->\s*$/;

/**
 * Exit-boundary sanitize for the full report comment. The tokenless step
 * writes the payload, so the publish step re-sanitizes it before passing it to
 * `gh`. The aftercare marker is the one HTML comment that must survive for
 * comment idempotency; it is re-appended only when the body legitimately ended
 * with it.
 */
export function sanitizeCommentBody(body: string): string {
  const hasMarker = TRAILING_MARKER_RE.test(body);
  const clean = sanitizeSummary(body);
  return hasMarker ? `${clean}\n\n${AFTERCARE_MARKER}` : clean;
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

// Comment links are assembled only from strictly validated parts because the
// sanitizer intentionally leaves markdown links intact. Invalid parts drop the
// link; the table remains readable without it.
const GITHUB_SLUG_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const VERSION_RE = /^[A-Za-z0-9.+-]+$/;
const DEPVISOR_REPO_URL = "https://github.com/morinokami/depvisor";

/** Package cell: link valid npm names/versions, otherwise render a code span. */
function packageCell(c: DependencyChange): string {
  const label = `\`${c.name}\``;
  if (!isValidNpmName(c.name) || !VERSION_RE.test(c.to)) return label;
  return `[${label}](https://www.npmjs.com/package/${c.name}/v/${c.to})`;
}

/**
 * Source links for a package from its resolved GitHub slug: the releases page,
 * plus a compare link guessing the common `v`-prefixed tag convention — a wrong
 * guess lands on GitHub's empty-compare page, which is why it stays a guess
 * instead of costing API calls to verify tags.
 */
function linksCell(c: DependencyChange, slug: string | null | undefined): string {
  if (!slug || !GITHUB_SLUG_RE.test(slug)) return "";
  const links = [`[releases](https://github.com/${slug}/releases)`];
  if (VERSION_RE.test(c.from) && VERSION_RE.test(c.to)) {
    links.push(`[compare](https://github.com/${slug}/compare/v${c.from}...v${c.to})`);
  }
  return links.join(" · ");
}

// Diff paths come from git and may hold any byte a filename can (spaces,
// backticks, brackets — all observed in real `git diff` output). The exit
// sanitizer leaves code spans and markdown links intact, so an unvalidated path
// could break out of its code span; only paths within this conservative charset
// are embedded, matching packageCell/linksCell's strict-parts stance. Others are
// dropped from the listing (but still counted, so nothing is hidden).
const SAFE_PATH_RE = /^[A-Za-z0-9 @._/-]+$/;

/** Whether a repo path is safe to embed in a markdown code span / table cell. */
export function isDisplayablePath(path: string): boolean {
  return SAFE_PATH_RE.test(path);
}

/**
 * A warning section listing test-looking files the REPAIR changed. The scope
 * gate cannot deny tests (a poisoned fixer could weaken assertions the same way
 * an honest repair adapts them — see core/test-changes.ts), so this raises
 * review attention where the verification gate cannot vouch. Only charset-safe
 * paths are listed; any dropped for unsafe names are still counted, and the
 * wording never implies that an empty section elsewhere proves no test was
 * touched.
 */
function testChangesSection(changes: readonly NumstatEntry[]): string {
  if (changes.length === 0) return "";
  const safe = changes.filter((c) => isDisplayablePath(c.path));
  const omitted = changes.length - safe.length;
  const rows = safe.map((c) => `| \`${c.path}\` | ${formatNumstatLines(c)} |`);
  const table = rows.length > 0 ? ["| File | Lines |", "|---|---|", ...rows].join("\n") : "";
  const omittedNote =
    omitted > 0
      ? `\n\n_${omitted} changed test file(s) with names that cannot be safely displayed were omitted from the list above._`
      : "";
  return (
    "## ⚠️ The repair modified tests\n\n" +
    `The repair changed ${changes.length} file(s) that look like tests. Adapting tests to a ` +
    "changed API is often legitimate, but it can also weaken the checks that verified this " +
    "repair — please review these diffs with extra care. Detection is heuristic (common naming " +
    "conventions only).\n\n" +
    table +
    omittedNote +
    "\n\n"
  );
}

/**
 * What the read-only digest agent reports: what changed UPSTREAM. `summary`
 * describes the update; `upstreamChanges` is the per-package release-notes
 * items relevant to this repo (rendered as "Notable changes"); `reviewNotes`
 * is what a reviewer should double-check. Display-only and untrusted (release
 * notes + LLM judgment), so this module sanitizes each field when it renders.
 */
export interface DigestReport {
  summary: string;
  upstreamChanges: NotableChange[];
  reviewNotes: string[];
}

/**
 * What the failure-path fixer agent reports: what it FIXED. `summary` is the
 * fixer's account of the repair; `fixesApplied` are the breaking changes it
 * adapted to (rendered as "Breaking changes addressed"); `residualRisks` are
 * risks it judges remain. Absent when no fixer ran. Same untrusted/sanitized
 * treatment as DigestReport.
 */
export interface FixerReport {
  summary: string;
  fixesApplied: string[];
  residualRisks: string[];
}

/** Deterministic fallback summary when the digest agent produced nothing. */
function changesSummary(changes: readonly DependencyChange[]): string {
  if (changes.length === 0) return "Updates dependencies.";
  return changes.map((c) => `Updates ${c.name} from ${c.from} to ${c.to}.`).join(" ");
}

/**
 * Compose the `UpdateNarrative` buildReportComment consumes from the two agent
 * reports. When `digest` is null (the digest agent failed — display-only and
 * fail-soft), the digest-owned fields fall back to a deterministic change
 * summary and empty arrays, so the report still describes the update.
 */
export function composeNarrative(
  digest: DigestReport | null,
  fixer: FixerReport | null,
  changes: readonly DependencyChange[],
): UpdateNarrative {
  const digestSummary = digest ? digest.summary : changesSummary(changes);
  const summary = fixer
    ? [digestSummary.trim(), fixer.summary.trim()].filter((s) => s.length > 0).join("\n\n")
    : digestSummary;
  return {
    summary,
    notableChanges: digest ? digest.upstreamChanges : [],
    breakingChangesAddressed: fixer?.fixesApplied ?? [],
    residualRisks: [...(fixer?.residualRisks ?? []), ...(digest ? digest.reviewNotes : [])],
  };
}

/** The kind marker in the change table's Type column. */
function kindSuffix(c: DependencyChange): string {
  return c.kind === "dev" ? " (dev)" : c.kind === "transitive" ? " (transitive)" : "";
}

/** The report's deterministic verdict line — never agent text. */
export type ReportVerdict = "green" | "repaired" | "deferred" | "repair-failed";

const VERDICT_LINES: Record<ReportVerdict, string> = {
  green: "✅ **Verification passes on this PR as-is.** No repair was needed.",
  repaired:
    "🔧 **This PR broke verification; depvisor repaired it.** The repair commit below is " +
    "bounded to source and tests, and the full verification suite passes with it.",
  deferred:
    "⚠️ **Verification fails on this PR and depvisor deferred the repair.** The reasons are " +
    "below; this update needs a human.",
  "repair-failed":
    "❌ **Verification fails on this PR and depvisor could not produce a passing repair.** " +
    "The details are below; this update needs a human.",
};

/**
 * Assemble the report comment from deterministic data plus the agents'
 * structured narrative. Every narrative field is untrusted and sanitized
 * field-by-field; every embedded link/path/version is charset-validated. The
 * marker is the last line (see sanitizeCommentBody).
 */
export function buildReportComment(args: {
  verdict: ReportVerdict;
  /**
   * The rendered change set: direct changes plus the bounded transitive
   * changes the caller chose to surface (kind "transitive").
   */
  changes: readonly DependencyChange[];
  /** Transitive changes beyond the bound — counted, never silently dropped. */
  omittedTransitives?: number;
  /** GitHub "owner/repo" per package; missing entries render without links. */
  sourceRepos?: ReadonlyMap<string, string | null>;
  /** Test-looking files the repair changed; non-empty adds a warning section. */
  testChanges?: readonly NumstatEntry[];
  /** Short sha of the repair commit, for the repair section. */
  repairShaShort?: string | null;
  /** The fixer's defer reason, when the verdict is "deferred". */
  deferReason?: string;
  narrative: UpdateNarrative;
  verification: VerifyResult[];
}): string {
  const {
    verdict,
    changes,
    omittedTransitives,
    sourceRepos,
    testChanges,
    repairShaShort,
    deferReason,
    narrative,
    verification,
  } = args;

  const links = changes.map((c) => linksCell(c, sourceRepos?.get(c.name)));
  const hasLinks = links.some((l) => l !== "");
  const versionTable =
    changes.length === 0
      ? "_No dependency change could be named from the lockfile or manifests._"
      : [
          `| Package | From | To | Type |${hasLinks ? " Links |" : ""}`,
          `|---|---|---|---|${hasLinks ? "---|" : ""}`,
          ...changes.map(
            (c, i) =>
              `| ${packageCell(c)} | ${sanitizeSummary(c.from)} | ${sanitizeSummary(c.to)} ` +
              `| ${c.updateType}${kindSuffix(c)} |` +
              (hasLinks ? ` ${links[i] ?? ""} |` : ""),
          ),
        ].join("\n");

  const transitiveNote =
    omittedTransitives && omittedTransitives > 0
      ? `\n\n_${omittedTransitives} further transitive package(s) also moved in the lockfile (omitted from the table)._`
      : "";

  const repairLine =
    verdict === "repaired" && repairShaShort && /^[0-9a-f]{4,40}$/.test(repairShaShort)
      ? `\n\nRepair commit: \`${repairShaShort}\` (committer \`depvisor[bot]\`; source and tests only — dependency state is never touched).`
      : "";
  const deferLine =
    verdict === "deferred" && deferReason
      ? `\n\nDefer reason: ${sanitizeSummary(deferReason).replace(/\s*\n\s*/g, " ")}`
      : "";

  // Drop notable-change entries for packages outside this update's table.
  const names = new Set(changes.map((c) => c.name));
  const notable = narrative.notableChanges
    .filter((n) => names.has(n.package))
    .map((n) => `\`${n.package}\`: ${n.note}`);

  const checks = verification
    .map((v) => `- ${v.ok ? "✅" : "❌"} ${v.name} (exit ${v.code})`)
    .join("\n");

  const narrativeSections =
    bulletSection("Notable changes", notable) +
    bulletSection("Breaking changes addressed", narrative.breakingChangesAddressed) +
    bulletSection("Risks and review notes", narrative.residualRisks);

  return [
    "## depvisor aftercare",
    "",
    VERDICT_LINES[verdict] + repairLine + deferLine,
    "",
    versionTable + transitiveNote,
    "",
    testChangesSection(testChanges ?? []) + "## What this update means here",
    "",
    sanitizeSummary(narrative.summary),
    "",
    narrativeSections + "## Verification",
    "",
    checks,
    "",
    "---",
    `_Report by [depvisor](${DEPVISOR_REPO_URL}). The narrative sections are LLM-written and sanitized; the verdict, tables, and verification results are deterministic._`,
    "",
    AFTERCARE_MARKER,
  ].join("\n");
}

/**
 * Emit the run's single publish payload under `<outDir>/payload.json`. The
 * agent-facing workflow ALWAYS stops here — pushing the repair and posting the
 * comment is a separate, token-holding step (`src/publish.ts`) so the agent's
 * execution environment never contains credentials.
 */
export function emitReportPayload(outDir: string, payload: ReportPayload): string {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, REPORT_PAYLOAD_FILE);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

/**
 * Remove prior-run output before a new run: the payload and the status file.
 * Without this a stale payload from a previous local run would be published.
 * Runs in deterministic code before the agent. In CI the checkout is fresh
 * each run, so this only matters for repeated local runs — but the failure
 * mode (publishing a stale repair) is bad enough to clear unconditionally.
 */
export function clearPrPreview(outDir: string): void {
  rmSync(join(outDir, REPORT_PAYLOAD_FILE), { force: true });
  rmSync(join(outDir, REPAIR_BUNDLE_FILE), { force: true });
  rmSync(join(outDir, RUN_STATUS_FILE), { force: true });
}
