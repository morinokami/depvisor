/**
 * Deterministic rendering of the maintained reviewer-report comment.
 *
 * Pure presentation over validated inputs: the publisher supplies the parsed
 * payload/context, the published commit (if any), the blob enumeration of the
 * linked tree, and pre-validated server/run URLs, then posts the returned
 * body verbatim. Agent-authored prose crosses the text.ts rendering boundaries
 * here, and evidenceLink stays the only agent-supplied URL that can render.
 */

import type { FixPayload } from "./fix-payload.ts";
import { REPORT_MARKER, generatorName, renderReportState } from "./report-state.ts";
import type { RunContext } from "./run-context.ts";
import { cleanReportText, evidenceLink, linkifyRepoPaths, repoFileUrl } from "./text.ts";

const MAX_COMMENT_CHARS = 60_000;
const MAX_REPORT_LINKS = 500;

export interface ReportLinkInputs {
  /** SHA of the pushed fix commit, or null for a no-fix or deferred review. */
  commitSha: string | null;
  /** Blob paths of the tree file links point into: the fix commit, or the snapshotted head. */
  blobPaths: ReadonlySet<string>;
  /** Validated https origin every built URL starts from. */
  server: string;
  /** Validated Actions-run URL for the footer, or null to render it unlinked. */
  runUrl: string | null;
}

function bullets(
  items: readonly string[],
  empty: string,
  render: (value: string) => string,
): string {
  return items.length > 0 ? items.map((item) => `- ${render(item)}`).join("\n") : `- ${empty}`;
}

/** Render the full marker comment, capped in size and link count. */
export function renderReportBody(
  payload: FixPayload,
  context: RunContext,
  links: ReportLinkInputs,
): string {
  const agent = payload.agent;
  const { commitSha, blobPaths, server, runUrl } = links;
  const linkSha = commitSha ?? context.pullRequest.headSha;
  let linkCount = 0;
  const fileUrl = (path: string): string | null => {
    if (linkCount >= MAX_REPORT_LINKS || !blobPaths.has(path)) return null;
    const url = repoFileUrl(server, payload.repository, linkSha, path);
    if (url !== null) linkCount += 1;
    return url;
  };
  const prose = (value: string, max?: number): string =>
    linkifyRepoPaths(cleanReportText(value, max), fileUrl);
  const upstream =
    agent.upstream_changes.length > 0
      ? agent.upstream_changes
          .map(
            (item) =>
              `- **${cleanReportText(item.dependency, 200)}:** ${prose(item.change)} ` +
              `_${prose(item.relevance)}_${evidenceLink(item.evidence_url)}`,
          )
          .join("\n")
      : "- No repository-relevant upstream change stood out from the available evidence.";
  const verification =
    agent.verification.length > 0
      ? agent.verification
          .map(
            (item) =>
              `- \`${cleanReportText(item.command, 500).replaceAll("`", "\\`")}\` — **${item.outcome}**: ` +
              prose(item.evidence),
          )
          .join("\n")
      : "- No local verification result was available.";
  const heading =
    agent.verdict === "defer"
      ? "Depvisor deferred this update"
      : commitSha
        ? "Depvisor pushed a fix"
        : "Depvisor reviewed this update";
  const runLink = runUrl === null ? "" : ` ([workflow run](${runUrl}))`;
  // A deferred review may leave unpublished working-tree edits behind, and
  // any file links point at the PR head rather than those edits — so the
  // deferred section is named "Attempted fix" and always carries the
  // not-published notice, listed edits or not.
  const fixHeading = agent.verdict === "defer" ? "Attempted fix" : "Fix";
  const changesFallback = commitSha
    ? "The fix commit contains the captured working-tree changes."
    : agent.verdict === "defer"
      ? "The agent left no working-tree edits."
      : "No fix was needed.";
  const deferNotice =
    agent.verdict === "defer"
      ? "\n_No fix was published. Any working-tree edits from this run were discarded._"
      : "";
  // Record the reviewed head only for a no-fix review: a pushed fix
  // moves the branch head, and the next CI pass must review that new head.
  const stateLine =
    commitSha === null && agent.verdict !== "defer"
      ? renderReportState({
          headSha: context.pullRequest.headSha,
          conclusion: context.trigger.conclusion,
          generator: generatorName(),
        })
      : null;
  const body = `${REPORT_MARKER}${stateLine === null ? "" : `\n${stateLine}`}
## ${heading}

${prose(agent.summary)}

### Relevant upstream changes

${upstream}

### ${fixHeading}

${bullets(agent.changes_made, changesFallback, prose)}
${commitSha ? `\nFix commit: \`${commitSha}\`` : ""}${deferNotice}

### Verification evidence

${verification}

### Residual risks

${bullets(agent.risks, "No additional repository-specific risk was identified.", prose)}
${agent.verdict === "defer" ? `\n**Why depvisor deferred:** ${prose(agent.defer_reason || "No safe bounded fix was found.")}` : ""}

Initial CI: **${cleanReportText(context.trigger.conclusion, 100)}**${context.trigger.url ? ` — ${cleanReportText(context.trigger.workflowName || "workflow run", 200)}${evidenceLink(context.trigger.url)}` : ""}.

_Generated by ${generatorName()}${runLink}. Review before merging._`;
  return body.slice(0, MAX_COMMENT_CHARS);
}
