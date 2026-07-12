/**
 * One processable dependency group, from the between-group reset through the
 * sealed PR payload. The discovered `workflows/update.ts` entrypoint owns all
 * cross-group state (branch collisions, PR budget, payload ordering, the
 * incremental run record); this nested support module owns the per-group gate
 * sequence and returns its effects explicitly.
 *
 * `requiresResetNext` is the caller-facing form of the old `firstProcessed`
 * mutation. It becomes true only after a clean baseline passes and the group is
 * about to run its deterministic bump. Before that boundary, a failed first
 * group has not dirtied the base install and the next processable group remains
 * the first. Once true it stays true for the remainder of the run.
 */

import {
  FlueError,
  ResultUnavailableError,
  type FlueHarness,
  type FlueLogger,
} from "@flue/runtime";
import * as v from "valibot";
import {
  DigestResult,
  digestNotes,
  digestPrompt,
  FixerResult,
  fixerPrompt,
  wantsSuggestions,
} from "../../agents/shared/tasks.ts";
import type { AdvisoryResult } from "../../core/advisories.ts";
import { applyUpdatePlan } from "../../core/bump.ts";
import { parseGithubSlug } from "../../core/changelog.ts";
import {
  changedPaths,
  commitAll,
  commitPaths,
  currentBranch,
  diffNumstat,
  discardWorkPast,
  ensureBranch,
  hasChanges,
  manifestBumpPaths,
  manifestDiff,
  resetToBase,
  revParse,
  snapshotWorktree,
  worktreeDrift,
} from "../../core/git.ts";
import { runInstall } from "../../core/install.ts";
import { classifyLicenseChanges, describeLicenseChanges } from "../../core/license.ts";
import type { PmToolchain } from "../../core/pm.ts";
import {
  buildPrPayload,
  composeNarrative,
  slugify,
  type DigestReport,
  type FixerReport,
  type PrPayload,
} from "../../core/pr.ts";
import { RefGuard } from "../../core/ref-guard.ts";
import { fetchPackument, type Packument } from "../../core/release-age.ts";
import { checkBumpScope, checkFixScope } from "../../core/scope.ts";
import { statusPackages, type GroupResult, type GroupUsage } from "../../core/status.ts";
import { classifyTestChanges } from "../../core/test-changes.ts";
import { logSafeText } from "../../core/text.ts";
import type { Group, RelevantNewFeature } from "../../core/types.ts";
import {
  runVerification,
  stripVerifyTails,
  type VerifyResult,
  type VerifyStep,
} from "../../core/verify.ts";

// A bump failure's captured output tail is registry/tool text — untrusted at
// the log/status boundary, so cap and sanitize it before recording a summary.
const BUMP_TAIL_MAX = 400;

export type GroupOutcome =
  | { kind: "recorded"; result: GroupResult; requiresResetNext: boolean }
  | {
      kind: "stop";
      status: "baseline-red" | "reset-failed";
      summary: string;
    }
  | {
      kind: "prepared";
      result: GroupResult;
      payload: PrPayload;
      consumedSlot: boolean;
      requiresResetNext: true;
    };

export interface ProcessGroupOptions {
  repo: string;
  group: Group;
  branch: string;
  base: string;
  verifySteps: VerifyStep[];
  pm: PmToolchain;
  resetCommand: string | null;
  requiresResetBefore: boolean;
  minimumReleaseAge: number;
  suggestFeatures: boolean;
  language: string;
  disposition: "refresh" | "open-new";
  packuments: Map<string, Packument | null>;
  advisories: AdvisoryResult;
  harness: FlueHarness;
  log: FlueLogger;
}

function dirtyPaths(repo: string): string {
  return changedPaths(repo).toSorted().join(", ");
}

function describeMembers(
  members: readonly { name: string; current: string; latest: string }[],
): string {
  return members.map((m) => `${m.name} ${m.current} -> ${m.latest}`).join(", ");
}

function projectUsage(
  role: GroupUsage["role"],
  response: {
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { total: number };
    };
    model: { provider: string; id: string };
  },
): GroupUsage {
  return {
    role,
    input: response.usage.input,
    output: response.usage.output,
    cacheRead: response.usage.cacheRead,
    cacheWrite: response.usage.cacheWrite,
    totalTokens: response.usage.totalTokens,
    costUsd: response.usage.cost.total,
    model: `${response.model.provider}/${response.model.id}`,
  };
}

function groupStart(title: string): void {
  if (process.env.GITHUB_ACTIONS) process.stdout.write(`::group::${title}\n`);
}

function groupEnd(): void {
  if (process.env.GITHUB_ACTIONS) process.stdout.write("::endgroup::\n");
}

function runVerificationPhase(repo: string, title: string, steps: VerifyStep[]): VerifyResult[] {
  groupStart(title);
  try {
    return runVerification(repo, steps);
  } finally {
    groupEnd();
  }
}

function stopOutcome(status: "baseline-red" | "reset-failed", summary: string): GroupOutcome {
  return { kind: "stop", status, summary };
}

export async function processGroup(opts: ProcessGroupOptions): Promise<GroupOutcome> {
  const {
    repo,
    group,
    branch,
    base,
    verifySteps,
    pm,
    resetCommand,
    minimumReleaseAge,
    suggestFeatures,
    language,
    disposition,
    packuments,
    advisories,
    harness,
    log,
  } = opts;
  const members = group.members;
  const pkgList = members.map((m) => m.name).join(", ");
  const packages = statusPackages(members);
  // Token/cost usage for this group's agent operations (visibility only). The
  // fixer path runs 0–2 operations (fixer and/or digest); each entry is pushed
  // the moment its task returns, so pre-agent outcomes record nothing.
  const usageEntries: GroupUsage[] = [];
  let requiresResetNext = opts.requiresResetBefore;

  // Every outcome shares the group identity fields; only status, summary, and
  // occasional extras (verification, testChanges) differ. usageEntries rides
  // along automatically once populated.
  const result = (status: string, summary: string, extra?: Partial<GroupResult>): GroupResult => ({
    status,
    branch,
    group: group.key,
    summary,
    packages,
    verification: [],
    prUrl: null,
    ...(usageEntries.length > 0 ? { usage: usageEntries } : {}),
    ...extra,
  });
  const recorded = (
    status: string,
    summary: string,
    extra?: Partial<GroupResult>,
  ): GroupOutcome => ({
    kind: "recorded",
    result: result(status, summary, extra),
    requiresResetNext,
  });
  // Install lifecycle scripts and target verification run with `.git`
  // reachable, so they can move ANY ref — including a PREVIOUS group's payload
  // branch or base, both still live targets because open-pr pushes all payloads
  // only after the run. Snapshot before this iteration's first untrusted
  // execution, record deliberate writes only from shas trusted code just
  // produced, and verify every boundary including failure paths. The HEAD
  // anchor is always an immutable sha, never a movable ref name.
  //
  // RefGuard owns expected-ref bookkeeping and exact restoration. This
  // function still owns policy: target-script drift fails, an unusable fixer
  // result restores quietly, and post-digest drift is display-only.
  const refGuard = RefGuard.capture(repo);
  const refFailure = (who: string, head: string, checkoutRef: string): GroupOutcome | null => {
    const drift = refGuard.intactAt(head, checkoutRef);
    if (drift === null) return null;
    return recorded(
      "unexpected-commits",
      `${who} moved git refs or HEAD (${drift.refs.join(", ") || "HEAD"}), but refs are ` +
        "written deterministically outside agents and scripts. Everything was " +
        "restored to the last trusted state; no PR.",
    );
  };

  // Between processed groups, reset to base and reinstall so post-update
  // failures remain attributable to this update. `requiresResetNext` stays true
  // once set.
  if (requiresResetNext) {
    if (resetCommand === null) {
      // install_command: skip and no lockfile → no reinstall is possible. The
      // first group ran on the pre-agent install; every later processable group
      // cannot. This is a red, fixable configuration gap, not the PR ceiling.
      return recorded(
        "reinstall-unavailable",
        "Cannot process this group: multi-group runs need a reinstall between groups, but " +
          "install_command is 'skip' and the repo has no committed lockfile. Commit a " +
          "lockfile or set install_command.",
      );
    }
    resetToBase(repo, base);
    const baseTipSha = revParse(repo, "HEAD");
    log.info(`reset to ${base}; reinstalling before ${branch}: ${resetCommand}`);
    const install = runInstall(repo, resetCommand);
    // Refs first, success or failure: a failing reinstall still ran some base
    // lifecycle scripts. The group branch may not exist yet, so restore to base.
    const installRefFailure = refFailure(
      "The group-boundary reinstall's lifecycle scripts",
      baseTipSha,
      base,
    );
    if (installRefFailure) return installRefFailure;
    if (!install.ok) {
      return stopOutcome(
        "reset-failed",
        `Reinstall between groups failed (exit ${install.code}) while resetting to '${base}' before ${branch}.`,
      );
    }
    if (hasChanges(repo)) {
      return stopOutcome(
        "reset-failed",
        `Reinstall between groups modified tracked or untracked repository files before ${branch}: ` +
          `${dirtyPaths(repo)}. Stopping before verification.`,
      );
    }
  }

  log.info(`preparing branch ${branch} from base ${base}`);
  ensureBranch(repo, branch, base);
  const preBumpSha = revParse(repo, "HEAD");
  // The branch now sits at the base tip. Record that deliberate write so a
  // restore recreates/resets it rather than deleting it. preBumpSha anchors
  // both baseline verification and the bump's install.
  refGuard.expectBranch(branch, preBumpSha);

  // Baseline verification is per processed group. Before the first bump a red
  // base is baseline-red; after any earlier bump it means reset-failed. Check
  // refs before trusting or reporting the scripts' result.
  log.info(`baseline verification (${verifySteps.length} steps) ...`);
  const baseline = runVerificationPhase(repo, "depvisor baseline verification", verifySteps);
  const baselineRefFailure = refFailure("The baseline verification scripts", preBumpSha, branch);
  if (baselineRefFailure) return baselineRefFailure;
  if (hasChanges(repo)) {
    const paths = dirtyPaths(repo);
    return requiresResetNext
      ? stopOutcome(
          "reset-failed",
          `Verification on '${base}' modified repository files after resetting from the previous group: ${paths}. Stopping before the bump.`,
        )
      : stopOutcome(
          "baseline-red",
          `Verification on '${base}' modified repository files before any update: ${paths}. Fix the baseline scripts first; no PR.`,
        );
  }
  const broken = baseline.find((r) => !r.ok);
  if (broken) {
    return requiresResetNext
      ? stopOutcome(
          "reset-failed",
          `Verification ('${broken.name}') fails on '${base}' after resetting from the previous group — the tree reset was incomplete. Stopping to keep failures attributable.`,
        )
      : stopOutcome(
          "baseline-red",
          `Verification ('${broken.name}') already fails on '${base}' before any update. Fix the baseline first; no agent run, no PR.`,
        );
  }
  log.info("baseline verification passed");

  // Past the point of no return: the bump/fixer can dirty the tree, so every
  // later processable group must reset/reinstall first.
  requiresResetNext = true;

  // Deterministic bump — update, install, and manifest edits are done by
  // LLM-free code before any agent runs.
  const plan = pm.updatePlan(members, repo, { pinExact: minimumReleaseAge > 0 });
  const applied = applyUpdatePlan(repo, plan);
  // Refs first, success or failure: the bump ran newly installed lifecycle
  // scripts. A script could commit its edits (hiding them from working-tree
  // gates), move another ref, or do either before a FAILING install returns.
  const bumpRefFailure = refFailure("The bump's install scripts", preBumpSha, branch);
  if (bumpRefFailure) return bumpRefFailure;
  if (!applied.ok) {
    // The fixer cannot touch manifests, so an ERESOLVE, catalog-edit failure,
    // hung command, or install failure is a per-group deterministic failure.
    const code = applied.code === null ? "no exit code" : `exit ${applied.code}`;
    const bumpTail = logSafeText(applied.outputTail, BUMP_TAIL_MAX);
    return recorded(
      "bump-failed",
      `The deterministic bump of ${pkgList} failed at step '${applied.step}' (${code}).` +
        (bumpTail ? ` Output tail: ${bumpTail}` : " No output was captured."),
    );
  }
  if (!hasChanges(repo)) {
    return recorded(
      "no-changes",
      `The deterministic bump of ${pkgList} produced no changes; nothing to open a PR for.`,
    );
  }

  // Bump-scope gate — BEFORE the mechanical commit. A lifecycle script could
  // rewrite scripts/overrides/trustedDependencies or another manifest surface
  // and otherwise ride in the supposedly mechanical commit, invisible to the
  // later fixer gate which diffs FROM that commit. Allow only plan-owned writes.
  const bumpScope = checkBumpScope(repo, preBumpSha, members, plan.catalogEdits);
  if (!bumpScope.ok) {
    return recorded(
      "scope-violation",
      `The bump left manifest changes beyond the update itself: ${bumpScope.violations.join(", ")}. ` +
        "This is most likely an install lifecycle script that rewrote a manifest. Nothing " +
        "was committed.",
    );
  }

  // Two commits: deterministic manifest/lockfile bump FIRST, before any agent;
  // only a validated source adaptation may become the second commit.
  const bumpSha = commitPaths(
    repo,
    manifestBumpPaths(repo, pm.lockfiles, pm.extraBumpFiles),
    `deps: bump ${pkgList}`,
  );
  if (bumpSha === null) {
    // hasChanges was true but nothing manifest-shaped changed: most likely an
    // install side effect. There is no mechanical bump to vouch for.
    return recorded(
      "bump-failed",
      `The bump of ${pkgList} changed files but none of them were manifests or lockfiles, ` +
        "so no mechanical bump commit could be made. Fail-closed; the changed files were " +
        "discarded.",
    );
  }
  log.info(`committed deterministic bump for ${pkgList} (${bumpSha.slice(0, 8)})`);
  // The branch now sits at the bump commit, the immutable anchor for every
  // post-bump/fix boundary. Agent profiles themselves cannot reach target git.
  refGuard.expectBranch(branch, bumpSha);

  // Source/test leftovers can only be install-script output; no fixer exists on
  // the fast path to vouch for them. Reject before verification so passing
  // checks cannot bless product code authored by untrusted install code.
  if (hasChanges(repo)) {
    return recorded(
      "scope-violation",
      `The bump's install scripts left non-manifest changes after the mechanical commit: ` +
        `${dirtyPaths(repo)}. Nothing was committed beyond the bump.`,
    );
  }

  // Full verification against the committed bump.
  log.info(`post-bump verification gate (${verifySteps.length} steps) ...`);
  const postBump = runVerificationPhase(repo, "depvisor post-bump verification", verifySteps);
  const postBumpRefFailure = refFailure("The post-bump verification scripts", bumpSha, branch);
  if (postBumpRefFailure) return postBumpRefFailure;
  if (hasChanges(repo)) {
    return recorded(
      "scope-violation",
      `The post-bump verification scripts modified tracked or untracked repository files: ` +
        `${dirtyPaths(repo)}. Verification is a gate, not a source author; no PR.`,
    );
  }

  // One independent session per group; fixer and digest are named subagents.
  const session = await harness.session(`group-${slugify(group.key)}`);
  let fixerReport: FixerReport | null = null;
  let verification: VerifyResult[];

  if (postBump.every((r) => r.ok)) {
    // Fast path: the bump verified clean, so no fixer runs.
    verification = stripVerifyTails(postBump);
  } else {
    // Failure path: hand bounded diagnostics to the fixer, then let the
    // deterministic gates—not its verdict—decide whether changes are accepted.
    let fixerResult: v.InferOutput<typeof FixerResult>;
    try {
      log.info(`fixer session starting for ${describeMembers(members)}`);
      const response = await session.task(
        fixerPrompt(
          members,
          verifySteps,
          postBump,
          manifestDiff(repo, base, "HEAD", pm.extraBumpFiles),
          language,
        ),
        { agent: "fixer", result: FixerResult },
      );
      // Capture usage before defensive re-parse and verdict handling: defer and
      // malformed returned data still spent tokens. A task that throws before
      // returning has no response usage to record.
      const usage = projectUsage("fixer", response);
      usageEntries.push(usage);
      fixerResult = v.parse(FixerResult, response.data);
      log.info(
        `fixer result: verdict=${fixerResult.verdict} ` +
          `(${usage.totalTokens} tokens, est. ~$${usage.costUsd.toFixed(4)})`,
      );
    } catch (err) {
      if (err instanceof ResultUnavailableError || err instanceof v.ValiError) {
        // Fail closed for this group, but keep processing others. Quietly undo
        // ref/HEAD movement first; a previous-group branch must not stay moved.
        refGuard.intactAt(bumpSha, branch);
        return recorded(
          "no-structured-result",
          "The fixer did not return a structured result; no PR was created. This is usually " +
            "transient and heals on the next run; if it recurs, the model may be struggling " +
            "with structured output — consider a stronger llm_model.",
        );
      }
      throw err;
    }

    // Ref integrity comes before trusting even a defer verdict.
    const fixerRefFailure = refFailure("The fixer session", bumpSha, branch);
    if (fixerRefFailure) return fixerRefFailure;

    if (fixerResult.verdict === "defer") {
      // A defer produces no PR; discard any half-finished source changes so the
      // next group's reset starts from deterministic state.
      const leftovers = hasChanges(repo);
      if (leftovers) discardWorkPast(repo, bumpSha);
      const reason = fixerResult.defer_reason
        ? `Deferred: ${fixerResult.defer_reason}`
        : `Deferred. ${fixerResult.summary}`;
      return recorded(
        "deferred",
        leftovers
          ? `${reason} (leftover changes from the deferred attempt were discarded)`
          : reason,
      );
    }

    // Authoritative source-only gate anchored at the bump commit.
    const scope = checkFixScope(repo, bumpSha);
    if (!scope.ok) {
      return recorded(
        "scope-violation",
        `The fixer touched paths outside source and tests: ${scope.violations.join(", ")}. Nothing was committed.`,
      );
    }
    const beforePostFixVerification = snapshotWorktree(repo);
    log.info(`post-fix verification gate (${verifySteps.length} steps) ...`);
    const postFix = runVerificationPhase(repo, "depvisor post-fix verification", verifySteps);
    // Verification executed updated dependency code; check refs before results.
    const postFixRefFailure = refFailure("The post-fix verification scripts", bumpSha, branch);
    if (postFixRefFailure) return postFixRefFailure;
    const verificationDrift = worktreeDrift(repo, beforePostFixVerification);
    if (verificationDrift.length > 0) {
      return recorded(
        "scope-violation",
        `The post-fix verification scripts modified repository files after the fixer scope ` +
          `gate: ${verificationDrift.join(", ")}. Nothing was committed.`,
      );
    }
    if (!postFix.every((r) => r.ok)) {
      return recorded("verification-failed", fixerResult.summary, {
        verification: stripVerifyTails(postFix),
      });
    }
    // Re-run scope immediately before commitAll. Worktree drift rejects even
    // in-scope verification edits; this independently prevents denied paths
    // from crossing the commit boundary.
    const finalScope = checkFixScope(repo, bumpSha);
    if (!finalScope.ok) {
      return recorded(
        "scope-violation",
        `The final fix contains paths outside source and tests: ${finalScope.violations.join(", ")}. Nothing was committed.`,
      );
    }
    // The fixer's validated source changes become the second commit.
    commitAll(repo, `fix: adapt code to ${pkgList} update`);
    verification = stripVerifyTails(postFix);
    fixerReport = {
      summary: fixerResult.summary,
      fixesApplied: fixerResult.fixes_applied,
      residualRisks: fixerResult.residual_risks,
    };
  }

  // Visibility, not a gate: tests are the one surface checkFixScope cannot deny
  // because adapting them to a changed API is legitimate. Warn reviewers but
  // never change membership, version, or PR identity.
  const testChanges = classifyTestChanges(diffNumstat(repo, base, "HEAD"));
  if (testChanges.length > 0) {
    log.info(`${testChanges.length} test file(s) changed in this update; flagged in the PR body`);
  }

  // One packument per member feeds source links and license warnings. Reuse the
  // cooldown cache; when cooldown is disabled fetch once here. Both signals are
  // optional/fail-open.
  await Promise.all(
    members
      .filter((m) => !packuments.has(m.name))
      .map(async (m) => {
        packuments.set(m.name, await fetchPackument(m.name));
      }),
  );
  const sourceRepos = new Map(
    members.map((m) => {
      const packument = packuments.get(m.name);
      return [m.name, packument ? parseGithubSlug(packument.repository) : null] as const;
    }),
  );
  const licenseChanges = classifyLicenseChanges(members, packuments);
  if (licenseChanges.length > 0) log.info(describeLicenseChanges(licenseChanges));

  // Digest runs strictly after commits are sealed. Its virtual sandbox and
  // read-only repo tools cannot write/exec on the host; any Flue/result failure
  // is display-only and falls back to deterministic narrative.
  const wantSuggestions = wantsSuggestions(suggestFeatures, members);
  const notesText = await digestNotes(members, packuments);
  // Content-addressed seal after bump plus optional fix. Updating the expected
  // branch is a no-op on the fast path where the tip is still bumpSha.
  const sealedSha = revParse(repo, "HEAD");
  refGuard.expectBranch(branch, sealedSha);
  let digestReport: DigestReport | null = null;
  let newFeatures: RelevantNewFeature[] = [];
  try {
    const response = await session.task(
      digestPrompt(members, notesText, wantSuggestions, language),
      { agent: "digest", result: DigestResult },
    );
    // Capture usage before the defensive re-parse.
    usageEntries.push(projectUsage("digest", response));
    const data = v.parse(DigestResult, response.data);
    digestReport = {
      summary: data.summary,
      upstreamChanges: data.upstream_changes,
      reviewNotes: data.review_notes,
    };
    // Render suggestions only under the same flag + non-patch condition that
    // emitted their instruction; ignore fields the model fills unbidden.
    newFeatures = wantSuggestions
      ? (data.relevant_new_features ?? []).map((f) => ({
          package: f.package,
          summary: f.summary,
          codebaseRelevance: f.codebase_relevance,
        }))
      : [];
  } catch (err) {
    // Broader than fixer on purpose: digest is display-only. ResultUnavailable
    // is not a FlueError, so name it explicitly; non-Flue bugs still crash.
    if (
      err instanceof FlueError ||
      err instanceof ResultUnavailableError ||
      err instanceof v.ValiError
    ) {
      const detail = Error.isError(err) ? err.message : String(err);
      log.warn(
        "The digest agent failed; preparing the PR with a deterministic summary and no " +
          `narrative digest. (${detail})`,
      );
    } else {
      throw err;
    }
  }

  // Defense-in-depth seal: delayed children of earlier install/verification
  // processes could still drift target refs/tree while digest runs. Restore the
  // exact sealed state and discard display data rather than failing an already
  // verified update. The later token-holding step pushes only after this run.
  const sealDrift = refGuard.intactAt(sealedSha, branch);
  if (sealDrift !== null || currentBranch(repo) !== branch || hasChanges(repo)) {
    if (sealDrift === null) refGuard.restore(branch);
    digestReport = null;
    newFeatures = [];
    log.warn(
      "Refs, checkout, or the tree drifted while the read-only digest ran; restored the " +
        "sealed state and discarded its report.",
    );
  }

  // Compose the sanitized payload; the caller assigns deterministic payload
  // order, writes it, and records status incrementally.
  const narrative = composeNarrative(digestReport, fixerReport, members);
  const payload = buildPrPayload({
    branch,
    base,
    candidates: members,
    sourceRepos,
    advisories: advisories.resolvedByPackage,
    testChanges,
    licenseChanges,
    newFeatures,
    narrative,
    verification,
  });
  return {
    kind: "prepared",
    result: result("pr-prepared", narrative.summary, {
      verification,
      ...(testChanges.length > 0 ? { testChanges } : {}),
    }),
    payload,
    consumedSlot: disposition === "open-new",
    requiresResetNext: true,
  };
}
