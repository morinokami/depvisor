export type ModelEnv = Record<string, string | undefined>;

export function requireModel(env: ModelEnv): string {
  const model = env.DEPVISOR_LLM_MODEL?.trim();
  if (!model) {
    throw new Error(
      "DEPVISOR_LLM_MODEL is not set. Pass the llm_model input, for example openai/gpt-5.5.",
    );
  }
  return model;
}
