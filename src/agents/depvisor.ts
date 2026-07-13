import { defineAgent, defineAgentProfile } from "@flue/runtime";
import digestInstructions from "./digest.md" with { type: "markdown" };
import fixerInstructions from "./fixer.md" with { type: "markdown" };
import { requireModel } from "./shared/model.ts";
import { releaseNotesTool } from "../tools/release-notes.ts";
import { repoReadTools, repoWriteTools } from "../tools/repo-files.ts";

export const description =
  "Prepares dependency-update PRs. The bump, install, and verification are deterministic; " +
  "an LLM is used only to fix source breakage (fixer) and to write the PR digest (digest).";

/**
 * The fixer runs ONLY when the deterministic post-bump verification fails. The
 * bump/install is already applied and committed, so the fixer edits source (and
 * tests, where an API changed) until the checks pass; it may not touch manifests,
 * lockfiles, or configuration — the scope gate (`checkFixScope`) enforces that.
 * It carries the bounded `fetch_release_notes` tool, the single narrow door for
 * the untrusted external text it may consult, and because the fixer runs only on
 * the failure path, that untrusted text reaches a repository-writing agent only
 * there. The fixer has no host shell: its only host bridge is the repo-jailed
 * read/write tool set, and the deterministic gates remain authoritative.
 */
const fixer = defineAgentProfile({
  name: "fixer",
  description:
    "Fixes source (and tests) to make the verification checks pass after a dependency bump " +
    "has already been applied. Never edits manifests, lockfiles, or configuration.",
  instructions: fixerInstructions,
  tools: [...repoReadTools, ...repoWriteTools, releaseNotesTool],
});

/**
 * The digest runs for EVERY prepared PR, strictly after both commits are sealed,
 * to write the reviewer-facing narrative. It reads the codebase to judge which
 * upstream changes matter through bounded read-only repo tools. Its built-in
 * filesystem/shell live in Flue's in-memory virtual sandbox, never on the host;
 * the release notes it is given are untrusted text, but it has no host write or
 * exec capability, so its only output is the sanitized structured result.
 */
const digest = defineAgentProfile({
  name: "digest",
  description:
    "Writes the reviewer-facing PR digest from the update's release notes and a read-only " +
    "look at the codebase. Read-only: never modifies files or runs state-changing commands.",
  instructions: digestInstructions,
  tools: [...repoReadTools],
});

/**
 * The depvisor agent is the root harness the workflow drives; it is never
 * prompted directly. The workflow runs the deterministic bump/install/verify and
 * delegates only the two LLM roles above via `session.task(..., { agent })`. The
 * default in-memory virtual sandbox is inherited by both subagents. The profile-
 * owned custom tools above are the only host bridge, which is what makes digest
 * read-only and keeps both roles away from depvisor's own checkout and the later
 * token-holding entrypoint.
 *
 * Flue discovers it by filename, but no `route` is exported, so the only caller
 * is the workflow that runs it between deterministic gates.
 */
export default defineAgent(() => ({
  model: requireModel(process.env),
  cwd: "/workspace",
  subagents: [fixer, digest],
}));
