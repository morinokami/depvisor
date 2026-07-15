/**
 * The run's configuration surface: every `DEPVISOR_*` knob the aftercare
 * workflow reads, parsed and validated in one place.
 *
 * The PR-identity knobs (`base_ref`, `head_ref`, `pr_number`) default from the
 * GitHub Actions `pull_request` event context in action.yml; the `language`
 * knob keeps its own parser module (`language.ts`). This module sequences them
 * and turns the first rejection into the run-level `bad-*` status the workflow
 * reports. That sequencing is why it lives in the core rather than inline in
 * the workflow: the summaries a user reads when a knob is mistyped are the
 * product's error UI, and the core is the half that can be unit-tested under
 * plain node, without an API key.
 *
 * Two conventions hold for every field:
 *   - An empty string means "not set" (the composite action forwards unset
 *     inputs as empty strings), so every read is a falsy check, never `??`.
 *   - Values come from the workflow file / Actions event context and are
 *     therefore TRUSTED. None may ever be sourced from the agent-writable
 *     target tree.
 *
 * `DEPVISOR_LLM_MODEL` is deliberately absent. It is the agent factory's input
 * (`agents/depvisor.ts`), not the workflow's, and it has no default.
 */

import { parseLanguage } from "./language.ts";

/** The environment a run is configured from — `process.env` in production. */
export type ConfigEnv = Record<string, string | undefined>;

// Conservative git ref-name grammar for the two ref knobs. They are embedded
// in git command lines and the status file, so anything outside plain branch
// naming is rejected: no leading '-'/'.'/'/', no '..', no trailing '/',
// charset limited to what real updater branches use
// (`dependabot/npm_and_yarn/lru-cache-11.0.0`, `renovate/lru-cache-11.x`).
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** Validate a branch-name knob; returns null on an unusable value. */
export function parseRefName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!REF_RE.test(trimmed)) return null;
  if (trimmed.includes("..") || trimmed.endsWith("/") || trimmed.endsWith(".lock")) return null;
  return trimmed;
}

/** Validate the pr_number knob; "" stays unset, else a positive integer. */
export function parsePrNumber(raw: string): number | null | "" {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

interface RunConfig {
  /**
   * The PR's base branch name (the updater targets it; the merge base against
   * it anchors baseline verification). Required — an aftercare run without a
   * base has nothing to attribute against.
   */
  baseRef: string;
  /**
   * The PR's head branch name (the updater's branch, checked out). Unset falls
   * back to the checked-out branch after preflight rejects a detached HEAD.
   */
  headRef: string | undefined;
  /**
   * The PR number, for the publish step's trusted lookup and the report. Unset
   * only in local/dev runs, which never publish.
   */
  prNumber: number | undefined;
  /**
   * Newline-separated shell commands that REPLACE auto-detected verification.
   * Consumed by preflight, which falls back to script auto-detection when empty.
   */
  verifyCommands: string;
  /**
   * The `install_command` input, forwarded for the baseline/head reinstalls: a
   * custom command is reused verbatim; `auto`/`skip`/unset fall back to the
   * PM's lockfile-faithful install (`skip` skips only the pre-agent install
   * step).
   */
  installCommand: string;
  /**
   * BCP-47-style tag for the language the fixer/digest write their narrative
   * fields in (`""` = unset = English, adding nothing to the prompts). Only
   * LLM free text is localized; deterministic strings are machine contracts.
   */
  language: string;
}

/**
 * A parsed config, or the first rejected knob — a run-level `bad-*` status the
 * workflow reports before it touches the target repository at all.
 */
export type ParsedRunConfig =
  | { ok: true; config: RunConfig }
  | { ok: false; status: string; summary: string };

/** Read a knob, treating an empty string as "not set". */
function read(env: ConfigEnv, name: string): string {
  return env[name] || "";
}

/**
 * Parse and validate every knob, in the order their `bad-*` statuses are
 * reported. The first rejection wins: a run with two mistyped knobs names only
 * the first, which is enough to send the user to their workflow file.
 */
export function parseRunConfig(env: ConfigEnv): ParsedRunConfig {
  const baseRefRaw = read(env, "DEPVISOR_BASE_REF");
  const baseRef = parseRefName(baseRefRaw);
  if (baseRef === null || baseRef === "") {
    return {
      ok: false,
      status: "bad-base-ref",
      summary:
        baseRef === ""
          ? "The base_ref input is required (the PR's base branch). Run depvisor on " +
            "pull_request events, where it defaults from the event context, or set it " +
            "explicitly (DEPVISOR_BASE_REF locally)."
          : `The base_ref input is not a usable branch name; got '${baseRefRaw.trim()}'.`,
    };
  }

  const headRefRaw = read(env, "DEPVISOR_HEAD_REF");
  const headRef = parseRefName(headRefRaw);
  if (headRef === null) {
    return {
      ok: false,
      status: "bad-head-ref",
      summary: `The head_ref input is not a usable branch name; got '${headRefRaw.trim()}'.`,
    };
  }

  const prNumberRaw = read(env, "DEPVISOR_PR_NUMBER");
  const prNumber = parsePrNumber(prNumberRaw);
  if (prNumber === null) {
    return {
      ok: false,
      status: "bad-pr-number",
      summary: `The pr_number input must be a positive integer; got '${prNumberRaw.trim()}'.`,
    };
  }

  const languageRaw = read(env, "DEPVISOR_LANGUAGE");
  const language = parseLanguage(languageRaw);
  if (language === null) {
    return {
      ok: false,
      status: "bad-language",
      summary:
        "The language input must be a BCP-47-style language tag such as 'ja' or 'pt-BR'; " +
        `got '${languageRaw.trim()}'.`,
    };
  }

  return {
    ok: true,
    config: {
      baseRef,
      headRef: headRef || undefined,
      prNumber: prNumber === "" ? undefined : prNumber,
      verifyCommands: read(env, "DEPVISOR_VERIFY_COMMANDS"),
      installCommand: read(env, "DEPVISOR_INSTALL_COMMAND"),
      language,
    },
  };
}
