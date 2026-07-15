/**
 * Preflight: never start agent work from a broken starting point.
 *
 * Every check here runs before any verification, LLM, or repair — against the
 * checked-out PR head and the fetched base. Each one fails the whole run
 * closed with its own status rather than degrading, because each represents a
 * starting condition under which no later gate could mean what it claims:
 *
 *   - `not-a-repo-root` — the scope gate and the repair commit are defined
 *     over a repository; without one there is nothing to diff against.
 *   - `persisted-credentials` — the second layer of the credentials gate (the
 *     action runs `check-credentials.ts` before even installing the target).
 *     This layer also covers local runs and workflows that bypass the composite
 *     action. See `credentials.ts` for the vectors it knows about.
 *   - `dirty-tree` — a repair built on someone else's uncommitted work would
 *     put changes depvisor never made into a commit it vouches for.
 *   - `unsupported-package-manager` / `ambiguous-package-manager` — the PM is
 *     pinned HERE, once, and drives every command the trusted steps later
 *     execute. Never re-detect after the agent has run: lockfiles are
 *     agent-writable.
 *   - `bad-head-ref` — the checkout must be a named branch (or head_ref must
 *     name it): the repair is published to that branch.
 *   - `missing-base-ref` — the base anchors the merge base that baseline
 *     verification and the dependency diff are computed against.
 *
 * Extracted from the workflow so it is unit-testable under plain node and so
 * the workflow's `run()` reads as orchestration.
 */

import { detectPersistedCredentials, persistedCredentialsSummary } from "./credentials.ts";
import { currentBranch, hasChanges, isRepoRoot, mergeBase, refExists, revParse } from "./git.ts";
import { detectPackageManager, type PmToolchain } from "./pm.ts";
import { parseVerifyCommands, verifyStepsFor, type VerifyStep } from "./verify.ts";

export type PreflightResult =
  | { ok: false; status: string; summary: string }
  | {
      ok: true;
      /** The PR head branch name the repair is published to. */
      headRef: string;
      /** The checked-out head commit — the updater tip this run consumes. */
      headSha: string;
      /** The merge base of base and head — the baseline/attribution anchor. */
      mergeBaseSha: string;
      verifySteps: VerifyStep[];
      pm: PmToolchain;
    };

export interface PreflightOptions {
  /** The `base_ref` input (required; validated by config.ts). */
  baseRef: string;
  /** The `head_ref` input; unset falls back to the checked-out branch. */
  headRef: string | undefined;
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
        "Refusing to analyze or repair on top of them; reset the tree and re-run.",
    };
  }
  // Detect the package manager pre-agent, against the checked-out head tree,
  // and pin the result for the whole run.
  const detected = detectPackageManager(repo);
  if (!detected.ok) {
    return { ok: false, status: detected.status, summary: detected.summary };
  }
  const pm = detected.pm;

  const checkedOut = currentBranch(repo);
  const headRef = opts.headRef ?? (checkedOut === "HEAD" ? undefined : checkedOut);
  if (!headRef) {
    return {
      ok: false,
      status: "bad-head-ref",
      summary:
        "The checkout is a detached HEAD and no head_ref input names the PR branch. " +
        "Check out the PR's head branch (actions/checkout with `ref: ${{ github.head_ref }}`) " +
        "or set the head_ref input.",
    };
  }
  const headSha = revParse(repo, "HEAD");

  // The base may exist as a local branch (fixture/local runs) or only as a
  // remote-tracking ref (a CI checkout of the head branch with fetch-depth 0).
  const baseCandidates = [opts.baseRef, `refs/remotes/origin/${opts.baseRef}`];
  const resolvedBase = baseCandidates.find((ref) => refExists(repo, ref));
  if (!resolvedBase) {
    return {
      ok: false,
      status: "missing-base-ref",
      summary:
        `Base branch '${opts.baseRef}' was not fetched into the checkout. Check out with ` +
        "`fetch-depth: 0` (or fetch the base branch) so the merge base can be computed.",
    };
  }
  const mergeBaseSha = mergeBase(repo, resolvedBase, "HEAD");
  if (mergeBaseSha === null) {
    return {
      ok: false,
      status: "missing-base-ref",
      summary:
        `No merge base exists between '${opts.baseRef}' and the checked-out head — the ` +
        "histories are unrelated or too shallow. Check out with `fetch-depth: 0`.",
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
        "verification gate cannot vouch for any repair. Nothing will be published. " +
        "If your checks go by other names, set the verify_commands action input " +
        "(DEPVISOR_VERIFY_COMMANDS locally).",
    };
  }
  return { ok: true, headRef, headSha, mergeBaseSha, verifySteps, pm };
}

/**
 * The command that restores node_modules to a ref's lockfile state (the
 * baseline checkout, and the return to head after it). A custom
 * `install_command` is trusted (workflow file/env) and reused verbatim.
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
