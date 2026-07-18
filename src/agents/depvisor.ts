import { defineAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import instructions from "./depvisor.md" with { type: "markdown" };
import { requireModel } from "../shared/env.ts";
import { REPO } from "../shared/target.ts";
import { npmDiffTool } from "../tools/npm-diff.ts";
import { releaseNotesTool } from "../tools/release-notes.ts";

export const description =
  "Turns an existing Dependabot or Renovate PR into a green, reviewable PR by investigating " +
  "the update, repairing the checkout when needed, running checks, and reporting evidence.";

/**
 * v2 deliberately gives one agent the same kind of host workspace and shell a
 * coding agent gets in auto mode. The model-provider key remains runtime-only;
 * local() exposes only Flue's default host allowlist (PATH/HOME/locale/etc.).
 * GitHub credentials are absent and publication happens after this process.
 * The two upstream-evidence tools are read-only, credential-free, and bounded.
 */
export default defineAgent(() => ({
  model: requireModel(process.env),
  instructions,
  cwd: REPO,
  sandbox: local(),
  tools: [releaseNotesTool, npmDiffTool],
}));
