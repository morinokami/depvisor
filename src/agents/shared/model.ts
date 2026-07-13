/**
 * Root-harness model selection. Flue resolves the model catalog before the
 * workflow action can parse config, even when dry-run will open no session.
 * Therefore dry-run needs a real catalog entry as a model-shaped sentinel.
 * It deliberately ignores any configured model and removes the built-in
 * providers' credentials first, so a future accidental model operation fails
 * closed instead of spending a key loaded from the project-root .env.
 */

export type ModelEnv = Record<string, string | undefined>;

export function requireModel(env: ModelEnv): string {
  const dryRunRaw = env.DEPVISOR_DRY_RUN?.trim();
  // Any nonempty value other than the valid normal `false` must survive root
  // initialization so parseRunConfig can report either dry-run or bad-dry-run.
  if (dryRunRaw && dryRunRaw !== "false") {
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENROUTER_API_KEY;
    return "openai/gpt-5.5";
  }

  const model = env.DEPVISOR_LLM_MODEL;
  if (!model) {
    throw new Error(
      "DEPVISOR_LLM_MODEL is not set. Set it to a model specifier such as " +
        "openai/gpt-5.5 or anthropic/claude-sonnet-5 (the llm_model input " +
        "in CI; .env for local runs).",
    );
  }
  return model;
}
