/**
 * The language knob: a deterministic, LLM-free parse of the output-language
 * tag the fixer and digest prompts append when set. It localizes ONLY the
 * LLM-written free text (the narrative fields of the structured results);
 * every deterministic string — statuses, commit messages, branch names, PR
 * titles, the versions marker, action outputs — stays English, because those
 * are machine contracts and PR identity.
 *
 * The default is empty = unset = English: the prompts gain no extra sentence
 * at all, keeping unset behavior bit-identical to before the knob existed.
 * The grammar deliberately accepts only a short BCP-47-style token
 * (`ja`, `pt-BR`, `zh-Hant`) and nothing freer: the value is concatenated
 * into the task prompts, so a loose grammar would degrade this knob into a
 * mini free-form prompt input — a rejected design (the trust model depends on
 * users not being able to instruct the agents). Anything else is fail-closed
 * (`null` → the run stops with `bad-language`), mirroring the other config
 * knobs so a typo fails loudly rather than silently writing English.
 */
const LANGUAGE_TAG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function parseLanguage(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (LANGUAGE_TAG_RE.test(trimmed)) return trimmed;
  return null;
}
