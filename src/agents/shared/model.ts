export type ModelEnv = Record<string, string | undefined>;

export function requireModel(env: ModelEnv): string {
  const model = env.DEPVISOR_LLM_MODEL?.trim();
  if (!model) {
    throw new Error("DEPVISOR_LLM_MODEL is required for reviewer/fixer jobs");
  }
  return model;
}
