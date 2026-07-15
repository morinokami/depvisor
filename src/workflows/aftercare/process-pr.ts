/**
 * One updater PR, from head verification through the sealed publish payload.
 * The discovered `workflows/aftercare.ts` entrypoint owns config, preflight,
 * the dependency diff, and the incremental run record; this nested support
 * module owns the verify → baseline → repair gate sequence and returns its
 * effects explicitly.
 *
 * The gate order is the attribution argument: the PR head is verified first
 * (green → report only, no baseline cost); only a red head buys the baseline
 * run on the merge base, which decides whether the failure is the update's
 * (fixer runs) or the repository's (`baseline-red`, fail-closed stop — a
 * repair could not be attributed to the update).
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
} from "../../agents/shared/tasks.ts";
import { parseGithubSlug } from "../../core/changelog.ts";
import type { DepDiff } from "../../core/dep-diff.ts";
import type { DependencyChange } from "../../core/types.ts";
import {
  changedPaths,
  checkoutDetached,
  checkoutForce,
  commitAll,
  currentBranch,
  diffNumstat,
  discardWorkPast,
  hasChanges,
  manifestDiff,
  revParse,
  snapshotWorktree,
  worktreeDrift,
} from "../../core/git.ts";
import { runInstall } from "../../core/install.ts";
import { fetchPackument, type Packument } from "../../core/packument.ts";
import type { PmToolchain } from "../../core/pm.ts";
import { RefGuard } from "../../core/ref-guard.ts";
import {
  buildReportComment,
  composeNarrative,
  type DigestReport,
  type FixerReport,
  type ReportPayload,
  type ReportVerdict,
} from "../../core/report.ts";
import { checkFixScope } from "../../core/scope.ts";
import type { OpUsage } from "../../core/status.ts";
import { classifyTestChanges } from "../../core/test-changes.ts";
import type { NumstatEntry } from "../../core/git.ts";
import {
  runVerification,
  stripVerifyTails,
  type VerifyResult,
  type VerifyStep,
} from "../../core/verify.ts";

// How many transitive changes join the prompts/report table alongside the
// direct ones. A major bump can move hundreds of transitives; the direct
// changes carry the story, so the tail is a bounded sample plus a count.
const MAX_TRANSITIVE_CHANGES = 20;

export type ProcessPrOutcome =
  | {
      /** Fail-closed stop: nothing publishable came out of this run. */
      kind: "stopped";
      status:
        | "baseline-red"
        | "reinstall-unavailable"
        | "reinstall-failed"
        | "scope-violation"
        | "unexpected-commits"
        | "no-structured-result";
      summary: string;
      verification: VerifyResult[];
      usage: OpUsage[];
    }
  | {
      /** A publish payload exists (repair and/or report comment). */
      kind: "prepared";
      status: "report-prepared" | "repair-prepared" | "deferred" | "verification-failed";
      summary: string;
      payload: ReportPayload;
      repaired: boolean;
      /** The rendered change set (direct + bounded transitives), for the record. */
      changes: DependencyChange[];
      verification: VerifyResult[];
      testChanges: NumstatEntry[];
      usage: OpUsage[];
    };

export interface ProcessPrOptions {
  repo: string;
  headRef: string;
  headSha: string;
  mergeBaseSha: string;
  baseRef: string;
  prNumber: number | undefined;
  depDiff: DepDiff;
  verifySteps: VerifyStep[];
  pm: PmToolchain;
  /** The reinstall command, or null (install_command: skip + no lockfile). */
  resetCommand: string | null;
  language: string;
  harness: FlueHarness;
  log: FlueLogger;
}

function dirtyPaths(repo: string): string {
  return changedPaths(repo).toSorted().join(", ");
}

function projectUsage(
  role: OpUsage["role"],
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
): OpUsage {
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

export async function processPr(opts: ProcessPrOptions): Promise<ProcessPrOutcome> {
  const {
    repo,
    headRef,
    headSha,
    mergeBaseSha,
    baseRef,
    prNumber,
    depDiff,
    verifySteps,
    pm,
    resetCommand,
    language,
    harness,
    log,
  } = opts;
  // The change set the prompts, packument lookups, and report table see:
  // direct changes plus a bounded slice of transitive ones — a lockfile-only
  // transitive/security update would otherwise reach the digest and the
  // reviewer as an anonymous count, defeating "understand and explain the
  // change". The overflow is counted, never silently dropped.
  const changes = [...depDiff.direct, ...depDiff.transitives.slice(0, MAX_TRANSITIVE_CHANGES)];
  const omittedTransitives = Math.max(0, depDiff.transitives.length - MAX_TRANSITIVE_CHANGES);
  const pkgList =
    depDiff.direct.map((c) => c.name).join(", ") ||
    changes.map((c) => c.name).join(", ") ||
    "dependencies";
  // Token/cost usage for this run's agent operations (visibility only); each
  // entry is pushed the moment its task returns, so pre-agent stops record
  // nothing.
  const usage: OpUsage[] = [];

  const stopped = (
    status: Extract<ProcessPrOutcome, { kind: "stopped" }>["status"],
    summary: string,
    verification: VerifyResult[] = [],
  ): ProcessPrOutcome => ({ kind: "stopped", status, summary, verification, usage });

  // Install lifecycle scripts and target verification run with `.git`
  // reachable, so they can move ANY ref — including the head branch whose tip
  // the publish step later pushes from. Snapshot before this run's first
  // untrusted execution, record deliberate writes only from shas trusted code
  // just produced, and verify every boundary including failure paths. The
  // HEAD anchor is always an immutable sha, never a movable ref name.
  const refGuard = RefGuard.capture(repo);
  const refFailure = (who: string, head: string, checkoutRef: string): ProcessPrOutcome | null => {
    const drift = refGuard.intactAt(head, checkoutRef);
    if (drift === null) return null;
    return stopped(
      "unexpected-commits",
      `${who} moved git refs or HEAD (${drift.refs.join(", ") || "HEAD"}), but refs are ` +
        "written deterministically outside agents and scripts. Everything was " +
        "restored to the last trusted state; nothing was published.",
    );
  };

  // 1. Verify the PR head as checked out. Green means no baseline run is
  //    needed at all: there is nothing to attribute.
  log.info(`head verification (${verifySteps.length} steps) ...`);
  const headRun = runVerificationPhase(repo, "depvisor head verification", verifySteps);
  const headRefFailure = refFailure("The head verification scripts", headSha, headRef);
  if (headRefFailure) return headRefFailure;
  if (hasChanges(repo)) {
    return stopped(
      "scope-violation",
      `The head verification scripts modified tracked or untracked repository files: ` +
        `${dirtyPaths(repo)}. Verification is a gate, not a source author; nothing was published.`,
    );
  }

  let fixerReport: FixerReport | null = null;
  let deferReason = "";
  let repairSha: string | null = null;
  let verdict: ReportVerdict;
  let verification: VerifyResult[];

  if (headRun.every((r) => r.ok)) {
    // Fast path: the update verifies clean as-is; the deliverable is the report.
    verdict = "green";
    verification = stripVerifyTails(headRun);
  } else {
    // 2. The head is red. Attribute the failure: verify the merge base — the
    //    tree the updater changed — under its own lockfile state. A red
    //    baseline is the repository's problem, not the update's, and a repair
    //    built on it could not be vouched for (fail-closed stop).
    if (resetCommand === null) {
      return stopped(
        "reinstall-unavailable",
        "The head verification failed and attributing the failure needs a baseline " +
          "install on the merge base, but install_command is 'skip' and the repo has no " +
          "committed lockfile, so no reinstall command exists. Commit a lockfile or set " +
          "install_command.",
        stripVerifyTails(headRun),
      );
    }
    log.info(`head verification failed; checking the baseline at ${mergeBaseSha.slice(0, 8)}`);
    checkoutDetached(repo, mergeBaseSha);
    const baseInstall = runInstall(repo, resetCommand);
    const baseInstallRefFailure = refFailure(
      "The baseline install's lifecycle scripts",
      mergeBaseSha,
      headRef,
    );
    if (baseInstallRefFailure) return baseInstallRefFailure;
    if (!baseInstall.ok) {
      return stopped(
        "reinstall-failed",
        `Installing the merge base's dependencies failed (exit ${baseInstall.code}); the head ` +
          "failure cannot be attributed. Nothing was published.",
        stripVerifyTails(headRun),
      );
    }
    const baseline = runVerificationPhase(repo, "depvisor baseline verification", verifySteps);
    const baselineRefFailure = refFailure(
      "The baseline verification scripts",
      mergeBaseSha,
      headRef,
    );
    if (baselineRefFailure) return baselineRefFailure;
    const brokenBase = baseline.find((r) => !r.ok);
    if (brokenBase || hasChanges(repo)) {
      // Leave the checkout back on the head branch for the next run.
      checkoutForce(repo, headRef);
      return stopped(
        "baseline-red",
        brokenBase
          ? `Verification ('${brokenBase.name}') already fails on the merge base of '${baseRef}' ` +
              "and this PR, so the head failure cannot be attributed to the update. Fix the " +
              "base first; no repair, nothing published."
          : "Verification on the merge base modified repository files, so its verdict cannot " +
              "be trusted. Fix the baseline scripts first; nothing published.",
        stripVerifyTails(baseline),
      );
    }
    log.info("baseline verification passed — the failure is the update's; returning to head");

    // 3. Back to the head under its own lockfile state, then hand the failure
    //    to the fixer.
    checkoutForce(repo, headRef);
    const headInstall = runInstall(repo, resetCommand);
    const headInstallRefFailure = refFailure(
      "The head reinstall's lifecycle scripts",
      headSha,
      headRef,
    );
    if (headInstallRefFailure) return headInstallRefFailure;
    if (!headInstall.ok) {
      return stopped(
        "reinstall-failed",
        `Reinstalling the head's dependencies after the baseline check failed (exit ${headInstall.code}). Nothing was published.`,
        stripVerifyTails(headRun),
      );
    }
    if (hasChanges(repo)) {
      return stopped(
        "reinstall-failed",
        `The head reinstall modified tracked or untracked repository files: ${dirtyPaths(repo)}. Nothing was published.`,
        stripVerifyTails(headRun),
      );
    }

    const session = await harness.session(`pr-${prNumber ?? headSha.slice(0, 8)}`);
    let fixerResult: v.InferOutput<typeof FixerResult>;
    try {
      log.info(`fixer session starting for ${pkgList}`);
      const response = await session.task(
        fixerPrompt(
          changes,
          verifySteps,
          headRun,
          manifestDiff(repo, mergeBaseSha, "HEAD", pm.extraManifestFiles),
          language,
        ),
        { agent: "fixer", result: FixerResult },
      );
      // Capture usage before defensive re-parse and verdict handling: defer and
      // malformed returned data still spent tokens. A task that throws before
      // returning has no response usage to record.
      const opUsage = projectUsage("fixer", response);
      usage.push(opUsage);
      fixerResult = v.parse(FixerResult, response.data);
      log.info(
        `fixer result: verdict=${fixerResult.verdict} ` +
          `(${opUsage.totalTokens} tokens, est. ~$${opUsage.costUsd.toFixed(4)})`,
      );
    } catch (err) {
      if (err instanceof ResultUnavailableError || err instanceof v.ValiError) {
        // Fail closed: quietly undo any ref/HEAD movement and stop.
        refGuard.intactAt(headSha, headRef);
        return stopped(
          "no-structured-result",
          "The fixer did not return a structured result; nothing was published. This is " +
            "usually transient and heals on the next run; if it recurs, the model may be " +
            "struggling with structured output — consider a stronger llm_model.",
          stripVerifyTails(headRun),
        );
      }
      throw err;
    }

    // Ref integrity comes before trusting even a defer verdict.
    const fixerRefFailure = refFailure("The fixer session", headSha, headRef);
    if (fixerRefFailure) return fixerRefFailure;

    if (fixerResult.verdict === "defer") {
      // A defer publishes no repair; discard any half-finished source changes
      // so the next run starts from deterministic state. The report comment
      // still goes out — explaining why this update needs a human is the
      // deliverable here.
      if (hasChanges(repo)) discardWorkPast(repo, headSha);
      verdict = "deferred";
      deferReason = fixerResult.defer_reason || fixerResult.summary;
      verification = stripVerifyTails(headRun);
      fixerReport = {
        summary: fixerResult.summary,
        fixesApplied: [], // no commit exists to carry them
        residualRisks: fixerResult.residual_risks,
      };
    } else {
      // Authoritative source-only gate anchored at the PR head commit.
      const scope = checkFixScope(repo, headSha);
      if (!scope.ok) {
        return stopped(
          "scope-violation",
          `The fixer touched paths outside source and tests: ${scope.violations.join(", ")}. ` +
            "Nothing was committed or published.",
        );
      }
      const beforePostFixVerification = snapshotWorktree(repo);
      log.info(`post-repair verification gate (${verifySteps.length} steps) ...`);
      const postFix = runVerificationPhase(repo, "depvisor post-repair verification", verifySteps);
      // Verification executed updated dependency code; check refs before results.
      const postFixRefFailure = refFailure(
        "The post-repair verification scripts",
        headSha,
        headRef,
      );
      if (postFixRefFailure) return postFixRefFailure;
      const verificationDrift = worktreeDrift(repo, beforePostFixVerification);
      if (verificationDrift.length > 0) {
        return stopped(
          "scope-violation",
          `The post-repair verification scripts modified repository files after the fixer ` +
            `scope gate: ${verificationDrift.join(", ")}. Nothing was committed or published.`,
        );
      }
      if (!postFix.every((r) => r.ok)) {
        // The attempted repair does not pass; discard it — an unverified repair
        // must never be committed or pushed. The report still goes out, with
        // the fixer's account demoted to narrative (no "fixes applied" claims:
        // no commit exists to carry them).
        discardWorkPast(repo, headSha);
        verdict = "repair-failed";
        verification = stripVerifyTails(postFix);
        fixerReport = {
          summary:
            `${fixerResult.summary}\n\n(The attempted repair did not pass verification and ` +
            "was discarded; the PR remains broken.)",
          fixesApplied: [],
          residualRisks: fixerResult.residual_risks,
        };
      } else {
        // Re-run scope immediately before commitAll. Worktree drift rejects even
        // in-scope verification edits; this independently prevents denied paths
        // from crossing the commit boundary.
        const finalScope = checkFixScope(repo, headSha);
        if (!finalScope.ok) {
          return stopped(
            "scope-violation",
            `The final repair contains paths outside source and tests: ${finalScope.violations.join(", ")}. Nothing was committed or published.`,
          );
        }
        // The fixer's validated source changes become the repair commit.
        // Preserve the trusted commit result as provenance: a fixer can be
        // invoked yet leave no accepted diff, which is still "no repair"
        // rather than an agent self-reported repair.
        repairSha = commitAll(repo, `fix: adapt code to ${pkgList} update`);
        verdict = repairSha !== null ? "repaired" : "green";
        verification = stripVerifyTails(postFix);
        fixerReport = {
          summary: fixerResult.summary,
          fixesApplied: repairSha !== null ? fixerResult.fixes_applied : [],
          residualRisks: fixerResult.residual_risks,
        };
        if (repairSha !== null) {
          log.info(`committed repair for ${pkgList} (${repairSha.slice(0, 8)})`);
          refGuard.expectBranch(headRef, repairSha);
        }
      }
    }
  }

  // Visibility, not a gate: tests are the one surface checkFixScope cannot deny
  // because adapting them to a changed API is legitimate. Warn reviewers but
  // never block the repair.
  const testChanges = classifyTestChanges(diffNumstat(repo, headSha, "HEAD"));
  if (testChanges.length > 0) {
    log.info(`${testChanges.length} test file(s) changed by the repair; flagged in the report`);
  }

  // One packument per direct change feeds source links and the digest's
  // release notes. Both signals are optional/fail-open.
  const packuments = new Map<string, Packument | null>();
  await Promise.all(
    changes.map(async (c) => {
      packuments.set(c.name, await fetchPackument(c.name));
    }),
  );
  const sourceRepos = new Map(
    changes.map((c) => {
      const packument = packuments.get(c.name);
      return [c.name, packument ? parseGithubSlug(packument.repository) : null] as const;
    }),
  );

  // Digest runs strictly after any repair commit is sealed. Its virtual
  // sandbox and read-only repo tools cannot write/exec on the host; any
  // Flue/result failure is display-only and falls back to the deterministic
  // narrative.
  const notesText = await digestNotes(changes, packuments);
  const sealedSha = revParse(repo, "HEAD");
  refGuard.expectBranch(headRef, sealedSha);
  let digestReport: DigestReport | null = null;
  try {
    const session = await harness.session(`pr-digest-${prNumber ?? headSha.slice(0, 8)}`);
    const response = await session.task(
      digestPrompt(changes, notesText, repairSha !== null, language),
      { agent: "digest", result: DigestResult },
    );
    // Capture usage before the defensive re-parse.
    usage.push(projectUsage("digest", response));
    const data = v.parse(DigestResult, response.data);
    digestReport = {
      summary: data.summary,
      upstreamChanges: data.upstream_changes,
      reviewNotes: data.review_notes,
    };
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
        "The digest agent failed; preparing the report with a deterministic summary and no " +
          `narrative digest. (${detail})`,
      );
    } else {
      throw err;
    }
  }

  // Defense-in-depth seal: delayed children of earlier install/verification
  // processes could still drift target refs/tree while digest runs. Restore the
  // exact sealed state and discard display data rather than failing an already
  // verified repair. The later token-holding step publishes only after this run.
  const sealDrift = refGuard.intactAt(sealedSha, headRef);
  if (sealDrift !== null || currentBranch(repo) !== headRef || hasChanges(repo)) {
    if (sealDrift === null) refGuard.restore(headRef);
    digestReport = null;
    log.warn(
      "Refs, checkout, or the tree drifted while the read-only digest ran; restored the " +
        "sealed state and discarded its report.",
    );
  }

  const narrative = composeNarrative(digestReport, fixerReport, changes);
  const commentBody = buildReportComment({
    verdict,
    changes,
    omittedTransitives,
    sourceRepos,
    testChanges,
    repairShaShort: repairSha ? repairSha.slice(0, 8) : null,
    ...(deferReason ? { deferReason } : {}),
    narrative,
    verification,
  });

  const payload: ReportPayload = {
    prNumber: prNumber ?? null,
    headRef,
    baseRef,
    expectedHeadSha: headSha,
    repairSha,
    commentBody,
  };

  const status =
    verdict === "green"
      ? "report-prepared"
      : verdict === "repaired"
        ? "repair-prepared"
        : verdict === "deferred"
          ? "deferred"
          : "verification-failed";
  const summary =
    verdict === "green"
      ? `Verification passes on this PR as-is; prepared the reviewer report. ${narrative.summary}`
      : verdict === "repaired"
        ? `Repaired this PR's verification failure with a bounded source commit. ${narrative.summary}`
        : verdict === "deferred"
          ? `The fixer deferred this repair: ${deferReason}`
          : `The PR fails verification and no passing repair was produced. ${narrative.summary}`;

  return {
    kind: "prepared",
    status,
    summary,
    payload,
    repaired: repairSha !== null,
    changes,
    verification,
    testChanges,
    usage,
  };
}
