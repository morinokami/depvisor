import type {
  AnalysisArtifact,
  FixerReport,
  ReviewerReport,
  VerificationArtifact,
} from "./artifacts.ts";
import { updateTypeFor } from "./policy.ts";
import { isTestPath } from "./test-changes.ts";
import type { V2Status } from "./types.ts";

export const REPORT_MARKER = "<!-- depvisor:v2 -->";
const MAX_TEXT = 8_000;
const MAX_REPORT = 60_000;

function clean(value: string, max = MAX_TEXT): string {
  const normalized = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\p{Cc}+/gu, " ")
    .trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function safe(value: string, max = MAX_TEXT): string {
  return clean(value, max)
    .replace(/([\\`*_[\]<>|])/g, "\\$1")
    .replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
}

function inlineCode(value: string, max = MAX_TEXT): string {
  return clean(value, max).replaceAll("`", "'");
}

export function renderReport(
  status: V2Status,
  analysis: AnalysisArtifact,
  reviewer: ReviewerReport | null,
  fixer: FixerReport | null,
  verification: readonly VerificationArtifact[],
  publishedHeadSha: string | null,
  candidatePaths: readonly string[],
): string {
  const lines = [
    REPORT_MARKER,
    "## depvisor aftercare",
    "",
    `**Result:** \`${status}\``,
    "",
    "### Dependency changes",
    "",
    "| Ecosystem | Package | Change | Type | Capability |",
    "| --- | --- | --- | --- | --- |",
    ...analysis.changes.map(
      (change) =>
        `| ${safe(change.ecosystem, 80)} | ${safe(change.package, 200)} | ` +
        `${safe(change.from ?? "—", 100)} → ${safe(change.to ?? "—", 100)} | ` +
        `${updateTypeFor(change)} | ${change.capability} |`,
    ),
  ];
  const collectedEvidence = analysis.changes
    .flatMap((change) => change.evidence.map((entry) => ({ package: change.package, entry })))
    .slice(0, 50);
  if (collectedEvidence.length > 0) {
    lines.push(
      "",
      "### Collected evidence",
      "",
      ...collectedEvidence.map(
        ({ package: packageName, entry }) =>
          `- **${safe(packageName, 200)}** [${entry.kind}] \`${inlineCode(entry.source, 1_000)}\` — ` +
          safe(entry.summary, 2_000),
      ),
    );
  }
  if (reviewer) {
    lines.push("", "### Reviewer summary", "", safe(reviewer.summary));
    if (reviewer.upstream_changes.length > 0) {
      lines.push(
        "",
        "### Relevant upstream changes",
        "",
        ...reviewer.upstream_changes.map(
          (entry) => `- **${safe(entry.package, 200)}:** ${safe(entry.note)}`,
        ),
      );
    }
    if (reviewer.observed_usage.length > 0) {
      lines.push("", "### Observed repository usage", "");
      lines.push(
        ...reviewer.observed_usage.map(
          (entry) =>
            `- \`${inlineCode(entry.path, 300)}\` \`${inlineCode(entry.symbol, 200)}\` — ${safe(entry.note)}`,
        ),
      );
    }
    if (reviewer.confirmed_risks.length > 0) {
      lines.push(
        "",
        "### Confirmed risks",
        "",
        ...reviewer.confirmed_risks.map((risk) => `- ${safe(risk)}`),
      );
    }
    if (reviewer.inferred_risks.length > 0) {
      lines.push(
        "",
        "### Inferred risks",
        "",
        ...reviewer.inferred_risks.map((risk) => `- ${safe(risk)}`),
      );
    }
    if (reviewer.reviewer_checks.length > 0) {
      lines.push(
        "",
        "### Reviewer checks",
        "",
        ...reviewer.reviewer_checks.map((item) => `- ${safe(item)}`),
      );
    }
    if (reviewer.evidence.length > 0) {
      lines.push(
        "",
        "### Evidence",
        "",
        ...reviewer.evidence.map((entry) => `- ${safe(entry, 1_000)}`),
      );
    }
  }
  if (fixer) {
    lines.push("", "### Fixer outcome", "", safe(fixer.summary));
    if (fixer.fixes_applied.length > 0) {
      lines.push("", ...fixer.fixes_applied.map((entry) => `- ${safe(entry)}`));
    }
    if (fixer.residual_risks.length > 0) {
      lines.push(
        "",
        "**Residual risks**",
        "",
        ...fixer.residual_risks.map((entry) => `- ${safe(entry)}`),
      );
    }
  }
  if (verification.length > 0) {
    lines.push("", "### Deterministic verification", "");
    for (const artifact of verification) {
      lines.push(`- **${artifact.phase}:** ${artifact.state} — ${safe(artifact.detail, 1_000)}`);
    }
  }
  if (publishedHeadSha) {
    lines.push("", `Repair commit: \`${publishedHeadSha}\``);
  }
  const testPaths = [...new Set(candidatePaths.filter(isTestPath))].toSorted();
  if (testPaths.length > 0) {
    lines.push(
      "",
      "### Test changes",
      "",
      "The fixer candidate touched test files; review the changed assertions explicitly.",
      "",
      ...testPaths.map((path) => `- \`${inlineCode(path, 500)}\``),
    );
  }
  lines.push("", `_Analyzed updater head \`${analysis.resolved.target.updaterHeadSha}\`._`);
  const report = `${lines.join("\n")}\n`;
  return report.length <= MAX_REPORT ? report : `${report.slice(0, MAX_REPORT)}\n…(truncated)\n`;
}
