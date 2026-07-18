/** Fail-closed required-environment lookup shared by the entrypoints. */
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Resolve the configured model specifier shared by the agent definitions. */
export function requireModel(env: Record<string, string | undefined>): string {
  const model = env.DEPVISOR_LLM_MODEL?.trim();
  if (!model) {
    throw new Error(
      "DEPVISOR_LLM_MODEL is not set. Pass the llm_model input, for example openai/gpt-5.5.",
    );
  }
  return model;
}
