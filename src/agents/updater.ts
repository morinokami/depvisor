import { defineAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import instructions from "./updater.md" with { type: "markdown" };
import { REPO } from "../shared/target.ts";
import { releaseNotesTool } from "../tools/release-notes.ts";

export const description =
  "Updates JS dependencies to target versions and edits the source to fix any resulting breakage until the verification scripts pass.";

// The model is injected instead of defaulted so consumers choose the provider.
// Composite actions forward unset inputs as "", so falsy means "not set".
// Throw from the factory so importing this module stays side-effect-free.
function requireModel(): string {
  const model = process.env.DEPVISOR_MODEL;
  if (!model) {
    throw new Error(
      "DEPVISOR_MODEL is not set. Set it to a model specifier such as " +
        "openai/gpt-5.5 or anthropic/claude-sonnet-5 (the llm_model input " +
        "in CI; .env for local runs).",
    );
  }
  return model;
}

/**
 * The updater agent bumps package(s), then fixes source breakage until the
 * checks pass. It works on the host checkout via Flue's `local()` sandbox,
 * which provides no host isolation; safety comes from the disposable CI runner,
 * egress restrictions, deterministic gates, and a token-free agent step.
 *
 * Flue discovers it by filename, but no `route` is exported, so the only caller
 * is the workflow that runs it between deterministic gates.
 */
export default defineAgent(() => ({
  model: requireModel(),
  sandbox: local(),
  cwd: REPO,
  instructions,
  tools: [releaseNotesTool],
}));
