/**
 * Root-harness model selection. Flue resolves the model catalog before the
 * workflow can parse config, so the model must be present at agent-factory
 * time; there is no user-facing default on purpose — a silent default model
 * would be a silent cost/behavior decision.
 */

export type ModelEnv = Record<string, string | undefined>;

export function requireModel(env: ModelEnv): string {
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
