import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidNpmName } from "./changelog.ts";
import type { NumstatEntry } from "./git.ts";
import type { LicenseChange } from "./license.ts";
import { RUN_STATUS_FILE } from "./status-file.ts";
import { formatNumstatLines } from "./test-changes.ts";
import type { Candidate, NotableChange, RelevantNewFeature, UpdateNarrative } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

export interface PrPayload {
  branch: string;
  base: string;
  title: string;
  body: string;
  /**
   * Deterministic labels applied to the PR by the token-holding open-pr step
   * (`depvisor`, `semver:*`, `security`, `dev-dependencies`). Derived from the
   * group members here, in the tokenless step; the exit boundary re-validates
   * every entry against a fixed allowlist (`sanitizeLabels`) because the payload
   * file is untrusted when open-pr reads it back.
   */
  labels: string[];
}

/**
 * A run prepares one payload per prepared PR, under this directory in the
 * pr-preview output. Filenames are `<NN>-<slug>.json` (processing order, then
 * the branch slug), so the token-holding open-pr step enumerates them
 * deterministically in order.
 */
export const PR_PAYLOADS_DIR = "payloads";

/**
 * Read-back shape validation for a payload file. The tokenless step wrote it,
 * so the token-holding open-pr step must not assume its shape: a JSON-parseable
 * but non-PrPayload file (`{}`, a bare string, a mistyped field) would
 * otherwise throw deep inside the push path (`payload.branch.startsWith`) and
 * kill the whole per-payload loop. Shape only, rebuilt field-by-field so extra
 * keys are dropped — content stays re-validated at the exit boundary as before
 * (sanitizeSummary/sanitizePrBody/sanitizeLabels, and prepareCleanPush's branch
 * and base checks). `labels` entries are deliberately not typed-checked here;
 * sanitizeLabels re-validates each against the allowlist anyway. Returns null
 * when the shape is wrong.
 */
export function parsePrPayload(raw: unknown): PrPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Partial<PrPayload>;
  if (typeof p.branch !== "string") return null;
  if (typeof p.base !== "string") return null;
  if (typeof p.title !== "string") return null;
  if (typeof p.body !== "string") return null;
  if (!Array.isArray(p.labels)) return null;
  return { branch: p.branch, base: p.base, title: p.title, body: p.body, labels: p.labels };
}

export function slugify(s: string): string {
  return s
    .replace(/@/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Branch name for a group: derived from the stable group key (the declared
 * group name, or the package's name/kind/updateType), never from the member
 * list. The key is the PR identity; the same package or declared group must
 * map to the same branch run after run.
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
    .map((m) => `${m.name}@${m.latest}@${[...m.locations].toSorted().join("~")}`)
    .toSorted()
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

// End-anchored (trailing whitespace tolerated for CRLF/web-edited bodies):
// buildPrPayload writes the marker as the body's last line, so the authentic
// marker is only ever the trailing one. An unanchored search would also match a
// marker-shaped string smuggled earlier in the body inside a code span — which
// sanitizeSummary deliberately preserves — letting agent narrative override the
// marker and pin skip-if-up-to-date to versions the PR does not deliver.
const TRAILING_VERSIONS_MARKER_RE = new RegExp(`${VERSIONS_MARKER_RE.source}\\s*$`);

/**
 * The strictly validated marker at the END of a PR body, or null. Shared by the
 * exit-boundary re-sanitize below and the workflow's skip-if-up-to-date
 * comparison, so both read the marker from the one position buildPrPayload
 * writes it to.
 */
export function extractVersionsMarker(body: string): string | null {
  const m = TRAILING_VERSIONS_MARKER_RE.exec(body);
  return m ? m[0].trimEnd() : null;
}

/**
 * Exit-boundary sanitize for a full PR body. The tokenless step writes the
 * payload file, so the push step re-sanitizes it before passing it to `gh`.
 * The versions marker is the one HTML comment that must survive for idempotency;
 * only a strictly validated trailing marker is extracted and re-appended.
 */
export function sanitizePrBody(body: string): string {
  const marker = extractVersionsMarker(body);
  const clean = sanitizeSummary(body);
  return marker ? `${clean}\n\n${marker}` : clean;
}

/**
 * The complete, fixed label vocabulary depvisor applies. Deterministic and
 * closed on purpose: the open-pr step ensures each label exists and adds it via
 * `gh`, so an arbitrary agent-supplied string must never reach that command.
 * Any label not on this allowlist is dropped at the exit boundary.
 */
const LABEL_RE = /^(?:depvisor|security|dev-dependencies|semver:(?:patch|minor|major))$/;

/**
 * Exit-boundary validation for PR labels, mirroring sanitizePrBody: the tokenless
 * step writes the payload, so the token-holding open-pr step re-validates the
 * labels before passing them to `gh`. Labels are a fixed vocabulary, so anything
 * outside LABEL_RE is dropped; duplicates collapse and order is stabilized so the
 * applied set is deterministic regardless of payload tampering.
 */
export function sanitizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const kept = new Set<string>();
  for (const label of labels) {
    if (typeof label === "string" && LABEL_RE.test(label)) kept.add(label);
  }
  return [...kept].toSorted();
}

// For a singleton group the semver:* label is simply that package's update
// level; a user-declared group can mix levels (majors included — the user said
// they move together), so the highest-rank fold below labels the group by its
// riskiest member.
const SEMVER_RANK = { patch: 0, minor: 1, major: 2 } as const;

/**
 * Derive the deterministic label set for a group: `depvisor` always, the
 * update's `semver:<level>`, `security` when any member resolves an advisory,
 * and `dev-dependencies` when every member is a dev dependency. LLM-free and
 * keyed only on the same inputs the version table uses, so labels can never
 * drift from what the PR shows. Ordering-only advisory data feeds `security`,
 * so a promoted security group and its label stay in lockstep.
 */
export function deriveLabels(
  candidates: readonly Candidate[],
  advisories?: ReadonlyMap<string, string[]>,
): string[] {
  const labels = ["depvisor"];

  let top: keyof typeof SEMVER_RANK | null = null;
  for (const c of candidates) {
    if (c.updateType === "unknown") continue;
    if (top === null || SEMVER_RANK[c.updateType] > SEMVER_RANK[top]) top = c.updateType;
  }
  if (top) labels.push(`semver:${top}`);

  if (candidates.some((c) => (advisories?.get(c.name)?.length ?? 0) > 0)) labels.push("security");

  if (candidates.length > 0 && candidates.every((c) => c.kind === "dev")) {
    labels.push("dev-dependencies");
  }

  return labels;
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

// GHSA ids are GHSA-xxxx-xxxx-xxxx (a lowercase base32 subset). Validated before
// embedding, matching linksCell's strict-parts stance (the sanitizer leaves
// markdown links intact). Any id that fails the shape is dropped from the cell.
const GHSA_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

/** Security cell: links to the GitHub advisory page for each resolved GHSA. */
function advisoryCell(ids: readonly string[] | undefined): string {
  if (!ids || ids.length === 0) return "";
  return ids
    .filter((id) => GHSA_RE.test(id))
    .map((id) => `[${id}](https://github.com/advisories/${id})`)
    .join(" · ");
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
 * A warning section listing test-looking files this update changed. The scope
 * gate cannot deny tests (a poisoned fixer could weaken assertions the same way
 * an honest update adapts them — see core/test-changes.ts), so this raises review
 * attention where the verification gate cannot vouch. Only charset-safe paths
 * are listed; any dropped for unsafe names are still counted, and the wording
 * never implies that an empty section on other PRs proves no test was touched.
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
    "## ⚠️ Tests were modified in this update\n\n" +
    `This update changed ${changes.length} file(s) that look like tests. Adapting tests to a ` +
    "changed API is often legitimate, but it can also weaken the checks that verified this PR " +
    "— please review these diffs with extra care. Detection is heuristic (common naming " +
    "conventions only); an empty section on other PRs is not a guarantee that no test was " +
    "touched.\n\n" +
    table +
    omittedNote +
    "\n\n"
  );
}

// License strings come from the untrusted npm registry. Only strings within this
// conservative, SPDX-shaped charset (letters, digits, spaces, and . + - ( ))
// are embedded, matching packageCell/linksCell's strict-parts stance: a backtick
// or bracket would break out of the code span the exit sanitizer preserves, and
// a `|` would break the table row. A change whose license fails the charset is
// dropped from the list but still counted, so nothing is hidden.
const LICENSE_RE = /^[A-Za-z0-9 .+()-]+$/;

/** Whether a license string is safe to embed in a markdown code span / table cell. */
function isDisplayableLicense(license: string): boolean {
  return LICENSE_RE.test(license);
}

/**
 * A warning section listing packages whose declared license changed between the
 * current and target version (see core/license.ts). Like testChangesSection this
 * is visibility, not a gate — a relicense is legitimate but among the easiest
 * changes to miss in review — and it makes NO claim about whether the new license
 * is more or less permissive; that reading is left to the human. Only
 * charset-safe license strings are shown; a change dropped for an unsafe string
 * is still counted, and detection is best-effort (registry `license` field only),
 * so an empty section is never a guarantee that no license changed.
 */
function licenseChangesSection(changes: readonly LicenseChange[]): string {
  if (changes.length === 0) return "";
  const safe = changes.filter((c) => isDisplayableLicense(c.from) && isDisplayableLicense(c.to));
  const omitted = changes.length - safe.length;
  const rows = safe.map((c) => `| \`${c.name}\` | \`${c.from}\` | \`${c.to}\` |`);
  const table =
    rows.length > 0 ? ["| Package | From | To |", "|---|---|---|", ...rows].join("\n") : "";
  const omittedNote =
    omitted > 0
      ? `\n\n_${omitted} license change(s) with values that cannot be safely displayed were omitted from the list above._`
      : "";
  return (
    "## ⚠️ License changed between versions\n\n" +
    `The declared license changed for ${changes.length} package(s) in this update. A relicense ` +
    "(for example to a source-available or copyleft license) can carry obligations your project " +
    "must accept — please confirm the new terms are acceptable. This compares the npm registry " +
    "`license` field as plain text only; it makes no judgment about whether the new license is " +
    "more or less permissive, and detection is best-effort.\n\n" +
    table +
    omittedNote +
    "\n\n"
  );
}

// At most this many suggestion bullets in the PR body; the rest are dropped
// with an explicit note (never silent truncation). Suggestions are secondary to
// the bump/verify/security content, so the section stays short by design.
const MAX_NEW_FEATURE_BULLETS = 5;

/**
 * A display-only section listing newly added capabilities depvisor noticed in
 * this update's release notes that may relate to code already in the repository
 * (the opt-in suggest_features feature — see core/suggest-features.ts). This is
 * NOT a gate and depvisor never adopts a suggestion; the wording says so and
 * never implies exhaustiveness. Each bullet's package label/version comes from
 * the validated candidate — suggestions whose `package` is not a member of this
 * group are dropped (the same render-time filter as notable_changes) — while the
 * untrusted free text (`summary`/`codebaseRelevance`, from release notes + LLM
 * judgment) is neutralized by the same sanitizeSummary + newline-collapse
 * treatment bulletSection applies. Over the cap, the excess is dropped with a
 * note. "" when nothing survives filtering, so the section only ever appears
 * when it has content.
 */
function newFeaturesSection(
  features: readonly RelevantNewFeature[],
  candidates: readonly Candidate[],
): string {
  const byName = new Map(candidates.map((c) => [c.name, c] as const));
  const bullets = features.flatMap((f) => {
    const c = byName.get(f.package);
    if (!c) return [];
    const label = `\`${c.name}@${c.latest}\``;
    const summary = sanitizeSummary(f.summary).replace(/\s*\n\s*/g, " ");
    const relevance = sanitizeSummary(f.codebaseRelevance).replace(/\s*\n\s*/g, " ");
    const text = [summary, relevance].filter((t) => t.length > 0).join(" — ");
    return [text ? `- **${label}** — ${text}` : `- **${label}**`];
  });
  if (bullets.length === 0) return "";
  const shown = bullets.slice(0, MAX_NEW_FEATURE_BULLETS);
  const omitted = bullets.length - shown.length;
  const omittedNote =
    omitted > 0 ? `\n\n_${omitted} further suggestion(s) were omitted to keep this short._` : "";
  return (
    "## 💡 New features that may be relevant\n\n" +
    "While preparing this update, depvisor noticed these newly added capabilities that look " +
    "related to code already in this repository. This is heuristic and not exhaustive, and " +
    "depvisor did NOT change any code to use them — they are surfaced for your consideration " +
    "only, to pick up in a separate change if you find them worthwhile.\n\n" +
    shown.join("\n") +
    omittedNote +
    "\n\n"
  );
}

/**
 * What the read-only PR digest agent reports (agent-as-fixer §5.2): what changed
 * UPSTREAM. `summary` describes the update; `upstreamChanges` is the per-package
 * release-notes items relevant to this repo (rendered as "Notable changes");
 * `reviewNotes` is what a reviewer should double-check. Display-only and
 * untrusted (release notes + LLM judgment), so pr.ts sanitizes each field when
 * it renders. Internal camelCase, like the existing narrative fields.
 */
export interface DigestReport {
  summary: string;
  upstreamChanges: NotableChange[];
  reviewNotes: string[];
}

/**
 * What the failure-path fixer agent reports (agent-as-fixer §5.2): what it FIXED.
 * `summary` is the fixer's account of the fix; `fixesApplied` are the breaking
 * changes it adapted to (rendered as "Breaking changes addressed");
 * `residualRisks` are risks it judges remain. Absent on the fast path (no fixer
 * ran). Same untrusted/sanitized treatment as DigestReport.
 */
export interface FixerReport {
  summary: string;
  fixesApplied: string[];
  residualRisks: string[];
}

/** Deterministic fallback summary when the digest agent produced nothing. */
function membersSummary(members: readonly Candidate[]): string {
  if (members.length === 0) return "Updates dependencies.";
  return members.map((m) => `Updates ${m.name} from ${m.current} to ${m.latest}.`).join(" ");
}

/**
 * Compose the `UpdateNarrative` buildPrPayload consumes from the split
 * agent-as-fixer reports, mapping them onto today's PR sections (§5.2) so the
 * generated PR is byte-compatible in shape:
 *   - summary → "What changed": the digest's summary, with the fixer's summary
 *     appended as its own paragraph when a fixer ran.
 *   - notableChanges → "Notable changes": the digest's upstream_changes.
 *   - breakingChangesAddressed → "Breaking changes addressed": the fixer's
 *     fixes_applied (empty on the fast path, so the section is omitted — today's
 *     behaviour, since bulletSection drops empty lists).
 *   - residualRisks → "Residual risks": the fixer's residual_risks then the
 *     digest's review_notes.
 * When `digest` is null (the digest agent failed — display-only and fail-soft
 * per §5.4), the digest-owned fields fall back to a deterministic member summary
 * and empty arrays, so a PR is still described.
 */
export function composeNarrative(
  digest: DigestReport | null,
  fixer: FixerReport | null,
  members: readonly Candidate[],
): UpdateNarrative {
  const digestSummary = digest ? digest.summary : membersSummary(members);
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
  /** Package name → advisory ids the update resolves; adds a Security column. */
  advisories?: ReadonlyMap<string, string[]>;
  /** Test-looking files this update changed; non-empty adds a warning section. */
  testChanges?: readonly NumstatEntry[];
  /** Packages whose declared license changed; non-empty adds a warning section. */
  licenseChanges?: readonly LicenseChange[];
  /**
   * Agent-suggested new features relevant to the codebase (opt-in
   * suggest_features); non-empty after member filtering adds a display-only
   * section. The workflow passes these only when the flag is on.
   */
  newFeatures?: readonly RelevantNewFeature[];
  narrative: UpdateNarrative;
  verification: VerifyResult[];
}): PrPayload {
  const {
    branch,
    base,
    candidates,
    sourceRepos,
    advisories,
    testChanges,
    licenseChanges,
    newFeatures,
    narrative,
    verification,
  } = args;

  const title =
    candidates.length <= 3
      ? `deps: update ${candidates.map((c) => `${c.name} ${c.current} to ${c.latest}`).join(", ")}`
      : `deps: update ${candidates.map((c) => c.name).join(", ")}`;

  // The Security and Links columns each exist only when at least one package
  // has content for them, so an ordinary PR keeps the plain three-column table.
  const security = candidates.map((c) => advisoryCell(advisories?.get(c.name)));
  const hasSecurity = security.some((s) => s !== "");
  const links = candidates.map((c) => linksCell(c, sourceRepos?.get(c.name)));
  const hasLinks = links.some((l) => l !== "");
  const versionTable = [
    `| Package | From | To |${hasSecurity ? " Security |" : ""}${hasLinks ? " Links |" : ""}`,
    `|---|---|---|${hasSecurity ? "---|" : ""}${hasLinks ? "---|" : ""}`,
    ...candidates.map(
      (c, i) =>
        `| ${packageCell(c)} | ${c.current} | ${c.latest} |` +
        (hasSecurity ? ` ${security[i] ?? ""} |` : "") +
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
    testChangesSection(testChanges ?? []) +
      licenseChangesSection(licenseChanges ?? []) +
      "## What changed",
    "",
    sanitizeSummary(narrative.summary),
    "",
    narrativeSections + newFeaturesSection(newFeatures ?? [], candidates) + "## Verification",
    "",
    checks,
    "",
    "---",
    `_Opened by [depvisor](${DEPVISOR_REPO_URL})._`,
    "",
    versionsMarker(candidates),
  ].join("\n");

  return { branch, base, title, body, labels: deriveLabels(candidates, advisories) };
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
