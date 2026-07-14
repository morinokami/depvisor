import { defineAgent, defineAgentProfile } from "@flue/runtime";
import reviewerInstructions from "./digest.md" with { type: "markdown" };
import fixerInstructions from "./fixer.md" with { type: "markdown" };
import { requireModel } from "./shared/model.ts";
import { releaseNotesTool } from "../tools/release-notes.ts";
import { repoReadTools, repoWriteTools } from "../tools/repo-files.ts";

export const description =
  "Analyzes existing Dependabot/Renovate PRs and proposes one bounded source/test repair when deterministic verification fails.";

const fixer = defineAgentProfile({
  name: "fixer",
  description: "Produces one source/test-only repair for an immutable updater head.",
  instructions: fixerInstructions,
  tools: [...repoReadTools, ...repoWriteTools, releaseNotesTool],
});

const reviewer = defineAgentProfile({
  name: "reviewer",
  description: "Writes an evidence-grounded, read-only dependency PR review.",
  instructions: reviewerInstructions,
  tools: [...repoReadTools],
});

export default defineAgent(() => ({
  model: requireModel(process.env),
  cwd: "/workspace",
  subagents: [fixer, reviewer],
}));
