/**
 * The run's configuration surface: every `DEPVISOR_*` knob the update workflow
 * reads, parsed and validated in one place.
 *
 * Each knob's own parser (`dry-run.ts`, `budget.ts`, `release-age.ts`,
 * `ignore.ts`, `grouping.ts`, `suggest-features.ts`, `language.ts`) owns its
 * default and its grammar — see those headers.
 * This module only sequences them and turns the first rejection into the
 * run-level `bad-*` status the workflow reports. That sequencing is why it
 * lives in the core rather than inline in the workflow: the summaries a user
 * reads when a knob is mistyped are the product's error UI, and the core is the
 * half that can be unit-tested under plain node, without an API key.
 *
 * Two conventions hold for every field:
 *   - An empty string means "not set" (the composite action forwards unset
 *     inputs as empty strings), so every read is a falsy check, never `??`.
 *   - Values come from the workflow file / env and are therefore TRUSTED. None
 *     may ever be sourced from the agent-writable target tree.
 *
 * Validation is unconditional: a typo'd exclusion is rejected even when the
 * cooldown is disabled, so it fails loudly now rather than the day the feature
 * is re-enabled.
 *
 * `DEPVISOR_LLM_MODEL` is deliberately absent. It is the agent factory's input
 * (`agents/depvisor.ts`), not the workflow's, and it has no default.
 */

import { parseOpenPullRequestsLimit } from "./budget.ts";
import { parseDryRun } from "./dry-run.ts";
import { type GroupRule, parseGroups } from "./grouping.ts";
import { type IgnoreRule, parseIgnore } from "./ignore.ts";
import { parseLanguage } from "./language.ts";
import type { NamePattern } from "./name-pattern.ts";
import { parseMinimumReleaseAge, parseMinimumReleaseAgeExclude } from "./release-age.ts";
import { parseSuggestFeatures } from "./suggest-features.ts";

/** The environment a run is configured from — `process.env` in production. */
export type ConfigEnv = Record<string, string | undefined>;

interface RunConfig {
  /** Plan selection and PR disposition without modifying the target or calling an LLM. */
  dryRun: boolean;
  /**
   * CI passes the default branch explicitly; local runs leave this unset and
   * fall back to the current branch after preflight rejects HEAD or depvisor/*.
   */
  baseBranch: string | undefined;
  /**
   * Path to a JSON snapshot of open PRs (`{headRefName, body}[]`), written by a
   * separate token-holding workflow step. Data flows in; credentials never do.
   */
  openPrsFile: string | undefined;
  /**
   * Newline-separated shell commands that REPLACE auto-detected verification.
   * Consumed by preflight, which falls back to script auto-detection when empty.
   */
  verifyCommands: string;
  /**
   * The `install_command` input, forwarded for the group-boundary reset: a
   * custom command is reused verbatim; `auto`/`skip`/unset fall back to the PM's
   * lockfile-faithful install (`skip` skips only the pre-agent install step).
   */
  installCommand: string;
  /**
   * Ceiling on the number of open depvisor PRs (Dependabot's
   * open-pull-requests-limit model). Refreshing an existing PR never consumes a
   * slot.
   */
  openPullRequestsLimit: number;
  /**
   * Minimum age (days) a version must have been public on the npm registry
   * before depvisor updates to it — the supply-chain cooldown. `0` disables it.
   */
  minimumReleaseAge: number;
  /**
   * Package names (or `@acme/*`-style prefix globs) exempted from the
   * cooldown's age check — the escape hatch for packages the public npm
   * registry cannot vouch for (private-registry packages), which would
   * otherwise go red as `release-age-unavailable` every run.
   */
  releaseAgeExclude: NamePattern[];
  /**
   * Rules (`name`, `name@<major>`, or a `prefix*` glob) that drop candidates
   * before grouping — the human-decided permanent counterpart to a fixer defer.
   */
  ignoreRules: IgnoreRule[];
  /**
   * User-declared package groups (`<group-name>: pkg pkg …`) updated together
   * in one branch/PR — Dependabot's `groups`; members are exact names or
   * `prefix*` globs. Empty = every package is its own group.
   */
  groupRules: GroupRule[];
  /**
   * When on, the digest prompt asks the agent to surface newly added
   * capabilities relevant to the codebase, rendered display-only in the PR body.
   * Off by default: it costs extra tokens and widens the agent's engagement with
   * untrusted release notes.
   */
  suggestFeatures: boolean;
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

/** `entry`/`entries`, so the rejection summaries read as English. */
function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

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
  const dryRunRaw = read(env, "DEPVISOR_DRY_RUN");
  const dryRun = parseDryRun(dryRunRaw);
  if (dryRun === null) {
    return {
      ok: false,
      status: "bad-dry-run",
      summary:
        "The dry_run input must be 'true' or 'false' (empty means false); " +
        `got '${dryRunRaw.trim()}'.`,
    };
  }

  const openPullRequestsLimitRaw = read(env, "DEPVISOR_OPEN_PULL_REQUESTS_LIMIT");
  const openPullRequestsLimit = parseOpenPullRequestsLimit(openPullRequestsLimitRaw);
  if (openPullRequestsLimit === null) {
    return {
      ok: false,
      status: "bad-open-pull-requests-limit",
      summary:
        "The open_pull_requests_limit input must be a positive integer; " +
        `got '${openPullRequestsLimitRaw.trim()}'.`,
    };
  }

  const minimumReleaseAgeRaw = read(env, "DEPVISOR_MINIMUM_RELEASE_AGE");
  const minimumReleaseAge = parseMinimumReleaseAge(minimumReleaseAgeRaw);
  if (minimumReleaseAge === null) {
    return {
      ok: false,
      status: "bad-minimum-release-age",
      summary:
        "The minimum_release_age input must be a non-negative integer (days); " +
        `got '${minimumReleaseAgeRaw.trim()}'.`,
    };
  }

  const releaseAgeExclude = parseMinimumReleaseAgeExclude(
    read(env, "DEPVISOR_MINIMUM_RELEASE_AGE_EXCLUDE"),
  );
  if (!releaseAgeExclude.ok) {
    return {
      ok: false,
      status: "bad-minimum-release-age-exclude",
      summary:
        `The minimum_release_age_exclude input has ${releaseAgeExclude.invalid.length} unrecognized ` +
        `${plural(releaseAgeExclude.invalid.length, "entry", "entries")}: ` +
        `${releaseAgeExclude.invalid.join(", ")}. Each line must be a package name ` +
        "or a trailing-'*' prefix glob like '@acme/*' (full-line '#' comments are " +
        "allowed); majors, version ranges, and other patterns are not supported.",
    };
  }

  const ignore = parseIgnore(read(env, "DEPVISOR_IGNORE"));
  if (!ignore.ok) {
    return {
      ok: false,
      status: "bad-ignore",
      summary:
        `The ignore input has ${ignore.invalid.length} unrecognized ` +
        `${plural(ignore.invalid.length, "entry", "entries")}: ${ignore.invalid.join(", ")}. ` +
        "Each line must be 'name' (never update it), 'name@<major>' (skip updates to " +
        "that major), a trailing-'*' prefix glob like '@types/*' (no major suffix), or " +
        "a full-line '#' comment; full version ranges and update-type rules are not " +
        "supported yet.",
    };
  }

  const groups = parseGroups(read(env, "DEPVISOR_GROUPS"));
  if (!groups.ok) {
    return {
      ok: false,
      status: "bad-groups",
      summary:
        `The groups input has ${groups.problems.length} invalid ` +
        `${plural(groups.problems.length, "entry", "entries")}: ${groups.problems.join("; ")}. ` +
        "Each line must be '<group-name>: <package> <package> …' — package names or " +
        "trailing-'*' prefix globs like '@acme/*', separated by spaces or commas, each " +
        "package in at most one group; full-line '#' comments are allowed. Other " +
        "patterns, version ranges, and majors are not supported.",
    };
  }

  const suggestFeaturesRaw = read(env, "DEPVISOR_SUGGEST_FEATURES");
  const suggestFeatures = parseSuggestFeatures(suggestFeaturesRaw);
  if (suggestFeatures === null) {
    return {
      ok: false,
      status: "bad-suggest-features",
      summary:
        "The suggest_features input must be 'true' or 'false' (empty means false); " +
        `got '${suggestFeaturesRaw.trim()}'.`,
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
      dryRun,
      baseBranch: env.DEPVISOR_BASE_BRANCH || undefined,
      openPrsFile: env.DEPVISOR_OPEN_PRS_FILE || undefined,
      verifyCommands: read(env, "DEPVISOR_VERIFY_COMMANDS"),
      installCommand: read(env, "DEPVISOR_INSTALL_COMMAND"),
      openPullRequestsLimit,
      minimumReleaseAge,
      releaseAgeExclude: releaseAgeExclude.exclude,
      ignoreRules: ignore.rules,
      groupRules: groups.rules,
      suggestFeatures,
      language,
    },
  };
}
