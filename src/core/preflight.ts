/**
 * Preflight: never start agent work from a broken starting point.
 *
 * Every check here runs against the TRUSTED base tree, before the deterministic
 * bump and before any LLM sees the repository. Each one fails the whole run
 * closed with its own status rather than degrading, because each represents a
 * starting condition under which no later gate could mean what it claims:
 *
 *   - `not-a-repo-root` — the scope gates and the two-commit split are defined
 *     over a repository; without one there is nothing to diff against.
 *   - `persisted-credentials` — the second layer of the credentials gate (the
 *     action runs `check-credentials.ts` before even installing the target).
 *     This layer also covers local runs and workflows that bypass the composite
 *     action. See `credentials.ts` for the vectors it knows about.
 *   - `dirty-tree` — a branch built on someone else's uncommitted work would
 *     put changes depvisor never made into a PR it vouches for.
 *   - `unsupported-package-manager` / `ambiguous-package-manager` — the PM is
 *     pinned HERE, once, and drives every command the trusted steps later
 *     execute. Never re-detect after the agent has run: lockfiles are
 *     agent-writable.
 *   - `bad-base-branch` / `missing-base-branch` — the base is the anchor of
 *     branch identity and of every reset between groups.
 *   - `no-verify-scripts` — the verification gate refusing to vouch means no
 *     PR, by design.
 *
 * Extracted from the workflow so it is unit-testable under plain node and so
 * the workflow's `run()` reads as orchestration.
 */

import { detectPersistedCredentials, persistedCredentialsSummary } from "./credentials.ts";
import { currentBranch, hasChanges, isRepoRoot, refExists } from "./git.ts";
import { detectPackageManager, type PmToolchain } from "./pm.ts";
import { parseVerifyCommands, verifyStepsFor, type VerifyStep } from "./verify.ts";

export type PreflightResult =
  | { ok: false; status: string; summary: string }
  | { ok: true; base: string; verifySteps: VerifyStep[]; pm: PmToolchain };

export interface PreflightOptions {
  /** The `base_branch` input; unset falls back to the checked-out branch. */
  baseBranch: string | undefined;
  /** The `verify_commands` input; empty falls back to script auto-detection. */
  verifyCommands: string;
}

export function preflight(repo: string, opts: PreflightOptions): PreflightResult {
  if (!isRepoRoot(repo)) {
    return {
      ok: false,
      status: "not-a-repo-root",
      summary:
        `${repo} is not the root of its own git repository. For the local fixture, ` +
        "run `pnpm run fixture:init` first.",
    };
  }
  const credentialFindings = detectPersistedCredentials(repo);
  if (credentialFindings.length > 0) {
    return {
      ok: false,
      status: "persisted-credentials",
      summary: persistedCredentialsSummary(credentialFindings),
    };
  }
  if (hasChanges(repo)) {
    return {
      ok: false,
      status: "dirty-tree",
      summary:
        `${repo} has uncommitted changes (likely a previous failed run). ` +
        "Refusing to build a branch on top of them; reset the tree and re-run.",
    };
  }
  // Detect the package manager pre-agent, against the trusted base tree, and
  // pin the result for the whole run.
  const detected = detectPackageManager(repo);
  if (!detected.ok) {
    return { ok: false, status: detected.status, summary: detected.summary };
  }
  const pm = detected.pm;
  const base = opts.baseBranch ?? currentBranch(repo);
  if (base === "HEAD" || base.startsWith("depvisor/")) {
    return {
      ok: false,
      status: "bad-base-branch",
      summary:
        `Refusing to use '${base}' as the base branch. Check out the intended base ` +
        "or set the base_branch action input (DEPVISOR_BASE_BRANCH locally).",
    };
  }
  if (!refExists(repo, base)) {
    return {
      ok: false,
      status: "missing-base-branch",
      summary:
        `Base branch '${base}' does not exist in the checkout. If this run was ` +
        "dispatched from a non-default branch, run it from the default branch or set " +
        "the base_branch input to a branch that was fetched.",
    };
  }
  // Explicit verify_commands replace auto-detection entirely; auto-detection
  // is only the fallback for the unconfigured case.
  const custom = parseVerifyCommands(opts.verifyCommands);
  const verifySteps = custom.length > 0 ? custom : verifyStepsFor(repo, pm);
  if (verifySteps.length === 0) {
    return {
      ok: false,
      status: "no-verify-scripts",
      summary:
        "The target package.json defines none of build/lint/test, so the " +
        "verification gate cannot vouch for any change. No PR will be made. " +
        "If your checks go by other names, set the verify_commands action input " +
        "(DEPVISOR_VERIFY_COMMANDS locally).",
    };
  }
  return { ok: true, base, verifySteps, pm };
}

/**
 * The command that restores the tree to the base lockfile state between groups.
 * A custom `install_command` is trusted (workflow file/env) and reused verbatim.
 * `auto`/`skip`/unset use the PM's frozen install, which is null only when the
 * repo tracks no lockfile (reachable only under `install_command: skip`).
 */
export function resolveResetCommand(
  pm: PmToolchain,
  repo: string,
  installCommand: string,
): string | null {
  const input = installCommand.trim();
  if (input && input !== "auto" && input !== "skip") return input;
  return pm.installCommand(repo);
}
