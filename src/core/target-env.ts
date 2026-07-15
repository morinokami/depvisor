/**
 * The environment handed to TARGET subprocesses (install lifecycle scripts and
 * verification commands). The agent step's own process necessarily holds the
 * LLM provider key (Flue reads it), but the target's scripts — and every
 * dependency package whose lifecycle hooks they run — must never see it: they
 * are exactly the untrusted code the token-separation model defends against.
 *
 * Scrubbed: the built-in providers' well-known key variables, plus whatever
 * variable the action resolved the key into (`DEPVISOR_LLM_KEY_ENV` names it —
 * action.yml exports that name alongside the key, so a custom
 * `llm_api_key_env` is covered too). Everything else is inherited: installs
 * legitimately need PATH, HOME, proxy settings, and private-registry tokens
 * the USER put in the environment on purpose.
 */

const BUILTIN_KEY_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];

export function targetEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of BUILTIN_KEY_VARS) delete env[name];
  const named = base.DEPVISOR_LLM_KEY_ENV;
  if (named) delete env[named];
  delete env.DEPVISOR_LLM_KEY_ENV;
  return env;
}
