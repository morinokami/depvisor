import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineWorkflow } from "@flue/runtime";
import depvisor from "../agents/depvisor.ts";
import {
  ADVISORIES_UNAVAILABLE_NOTE,
  describeAdvisories,
  fetchAdvisories,
  prioritizeGroups,
  type AdvisoryResult,
} from "../core/advisories.ts";
import { classifyGroup, countOpenDepvisorPrs } from "../core/budget.ts";
import { collectCandidates } from "../core/collect.ts";
import { parseRunConfig } from "../core/config.ts";
import { isClean, tryCheckout } from "../core/git.ts";
import { groupCandidates } from "../core/grouping.ts";
import { applyIgnore, describeIgnore } from "../core/ignore.ts";
import { preflight, resolveResetCommand } from "../core/preflight.ts";
import {
  branchNameForGroup,
  clearPrPreview,
  emitPrPayload,
  extractVersionsMarker,
  versionsMarker,
} from "../core/pr.ts";
import { applyReleaseAge, describeReleaseAge, type Packument } from "../core/release-age.ts";
import {
  emitRunStatus,
  groupLogLine,
  RUN_OUTPUT_SCHEMA,
  runFailsJob,
  runLogLine,
  statusFailsJob,
  statusPackages,
  toRunOutput,
  type GroupResult,
  type RunStatus,
} from "../core/status.ts";
import type { VerifyStep } from "../core/verify.ts";
import { REPO } from "../shared/target.ts";
import { processGroup } from "./update/process-group.ts";

const PR_OUT_DIR = fileURLToPath(new URL("../../pr-preview", import.meta.url));

/**
 * Open-PR snapshot, or [] when absent. Skip-if-up-to-date degrades gracefully
 * without it (a missed skip just re-runs the agent), but the
 * open_pull_requests_limit ceiling counts from it, so its accuracy matters: in
 * CI the snapshot step fails the job if `gh pr list` fails, but a truncated
 * snapshot (more open PRs than its --limit) or an absent/unreadable one (local
 * runs) fails open toward opening more PRs — the ceiling can be exceeded, never
 * the reverse.
 */
function readOpenPrs(file: string | undefined): { headRefName?: string; body?: string }[] {
  if (!file) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const pr: { headRefName?: string; body?: string } = {};
      if ("headRefName" in entry && typeof entry.headRefName === "string") {
        pr.headRefName = entry.headRefName;
      }
      if ("body" in entry && typeof entry.body === "string") pr.body = entry.body;
      return [pr];
    });
  } catch {
    return [];
  }
}

function describeVerifySteps(steps: VerifyStep[]): string {
  return steps.map((step) => step.name).join(", ");
}

/** Human-readable one-liner for a completed run. */
function summarizeRun(run: RunStatus): string {
  const count = (status: string) => run.groups.filter((g) => g.status === status).length;
  const parts = [`Prepared ${count("pr-prepared")} PR(s) from ${run.groups.length} group(s).`];
  const held = count("held-back-by-limit");
  if (held > 0) parts.push(`${held} group(s) held back by the open_pull_requests_limit ceiling.`);
  return parts.join(" ");
}

export default defineWorkflow({
  agent: depvisor,
  // The status shape is single-sourced in core/status.ts; toRunOutput below is
  // the projector derived from this same schema.
  output: RUN_OUTPUT_SCHEMA,

  async run({ harness, log }) {
    // Deterministic pre-agent cleanup so a stale payload from a previous local
    // run cannot be pushed and the incremental status stays consistent.
    clearPrPreview(PR_OUT_DIR);

    const finish = (run: RunStatus) => {
      emitRunStatus(PR_OUT_DIR, run);
      const line = runLogLine(run);
      if (runFailsJob(run)) log.warn(line);
      else log.info(line);
      return toRunOutput(run);
    };

    // 0. Config, then preflight. Config is parsed first so a mistyped knob is
    //    reported without touching the target repository at all; its `bad-*`
    //    statuses therefore carry no base branch (nothing has been detected yet).
    const parsedConfig = parseRunConfig(process.env);
    if (!parsedConfig.ok) {
      return finish({
        status: parsedConfig.status,
        base: null,
        summary: parsedConfig.summary,
        groups: [],
      });
    }
    const config = parsedConfig.config;
    const { minimumReleaseAge, openPullRequestsLimit, suggestFeatures, language } = config;

    const pre = preflight(REPO, {
      baseBranch: config.baseBranch,
      verifyCommands: config.verifyCommands,
    });
    if (!pre.ok) {
      return finish({ status: pre.status, base: null, summary: pre.summary, groups: [] });
    }
    const { base, verifySteps, pm } = pre;

    const resetCommand = resolveResetCommand(pm, REPO, config.installCommand);
    log.info(
      `preflight ok: pm=${pm.name}, base=${base}, open_pull_requests_limit=${openPullRequestsLimit}, ` +
        `minimum_release_age=${minimumReleaseAge}, suggest_features=${suggestFeatures}, ` +
        `verify steps: ${describeVerifySteps(verifySteps)}`,
    );

    // 1. Scan + group (once — groups are disjoint and the tree returns to base
    //    between groups, so a single collect is valid for every group). Between
    //    collect and grouping sits the minimum_release_age clamp: it can change
    //    a candidate's latest AND updateType, and grouping (branch/PR identity)
    //    depends on updateType, so it must run before groups are formed.
    const collected = collectCandidates(REPO, pm);
    // Ignore runs first — before the cooldown clamp and grouping — so a
    // human-excluded package never costs a packument fetch, an agent run, or a
    // spurious red release-age-unavailable entry. A `name@<major>` rule matches
    // the raw registry latest here (see core/ignore.ts).
    const { kept: notIgnored, ignored } = applyIgnore(collected, config.ignoreRules);
    const ignoreNote = describeIgnore(ignored);
    if (ignoreNote) log.info(ignoreNote);

    const packuments = new Map<string, Packument | null>();
    let candidates = notIgnored;
    let releaseAgeNote = "";
    let releaseAgeUnavailable: typeof collected = [];
    if (minimumReleaseAge > 0 && notIgnored.length > 0) {
      const aged = await applyReleaseAge(notIgnored, minimumReleaseAge, {
        packuments,
        exclude: config.releaseAgeExclude,
      });
      candidates = aged.kept;
      releaseAgeUnavailable = aged.unavailable;
      releaseAgeNote = describeReleaseAge(aged, minimumReleaseAge);
      if (releaseAgeNote) log.info(releaseAgeNote);
    }
    let groups = groupCandidates(candidates, config.groupRules);
    if (groups.length === 0 && releaseAgeUnavailable.length === 0) {
      const notes = [ignoreNote, releaseAgeNote].filter(Boolean).join(" ");
      return finish({
        status: "no-updates",
        base,
        summary: notes
          ? `No update groups to process. ${notes}`
          : "No outdated dependencies found.",
        groups: [],
      });
    }

    // Security prioritization (core/advisories.ts): stable-promote groups whose
    // update RESOLVES a known advisory to the front, so the open_pull_requests_limit budget below
    // spends its slots on security fixes first. Runs on the post-clamp `latest`
    // (a fix still inside the cooldown window does not count — cooldown wins) and
    // is fail-soft: an OSV outage keeps the neutral localeCompare order rather
    // than failing the run. The resolved-advisory map also feeds the PR body's
    // Security column below.
    let advisories: AdvisoryResult = { resolvedByPackage: new Map(), ok: true };
    // Set on an OSV outage and appended to the completed run's summary below:
    // the run stays green (fail-soft), so the summary note is the only place a
    // user can notice the degradation without reading the raw step log.
    let osvUnavailableNote = "";
    if (groups.length > 0) {
      advisories = await fetchAdvisories(candidates);
      if (advisories.ok) {
        groups = prioritizeGroups(groups, advisories.resolvedByPackage);
        const advisoryNote = describeAdvisories(advisories.resolvedByPackage);
        if (advisoryNote) log.info(advisoryNote);
      } else {
        osvUnavailableNote = ADVISORIES_UNAVAILABLE_NOTE;
        log.warn(osvUnavailableNote);
      }
    }

    // Budget (open_pull_requests_limit = ceiling on open depvisor PRs): map each open PR's
    // branch to its body — the keys count toward the ceiling, the bodies feed
    // skip-if-up-to-date. Only a newly opened PR consumes a slot; refreshing an
    // existing PR does not.
    const bodyByBranch = new Map<string, string>();
    for (const p of readOpenPrs(config.openPrsFile)) {
      if (typeof p.headRefName === "string" && p.headRefName) {
        bodyByBranch.set(p.headRefName, p.body ?? "");
      }
    }
    const openDepvisorCount = countOpenDepvisorPrs(bodyByBranch.keys());
    let newSlots = Math.max(0, openPullRequestsLimit - openDepvisorCount);
    log.info(
      `${candidates.length} candidates -> ${groups.length} groups; ${openDepvisorCount} open depvisor PR(s), ${newSlots} new-PR slot(s) (open_pull_requests_limit=${openPullRequestsLimit})`,
    );

    // The run starts as `in-progress` — a job-failing status — and only the
    // graceful finish below upgrades it to `completed`. If the process dies
    // mid-loop, the last incremental write is what report-status reads, and it
    // must fail the job instead of impersonating a green completed run.
    const run: RunStatus = {
      status: "in-progress",
      base,
      summary:
        "The run was interrupted before it finished; the groups below are only " +
        "those completed before the stop.",
      groups: [],
    };
    const recordGroup = (g: GroupResult): void => {
      run.groups.push(g);
      // Incremental write: if the loop throws, the emitted payloads and the
      // status file stay consistent about what has been done so far.
      emitRunStatus(PR_OUT_DIR, run);
      const line = groupLogLine(g);
      if (statusFailsJob(g.status)) log.warn(line);
      else log.info(line);
    };

    // Fail-closed-and-loud: candidates whose release age could not be verified
    // were dropped before grouping; record each as a red group entry (branch
    // and group are null — no branch was ever formed) so runFailsJob turns the
    // job red while the remaining groups still run.
    for (const c of releaseAgeUnavailable) {
      recordGroup({
        status: "release-age-unavailable",
        branch: null,
        group: null,
        summary:
          `Could not verify the release age of ${c.name}@${c.latest} against the npm ` +
          "registry (fetch failed or package not found), so this update was dropped " +
          "for the run (fail-closed). A transient registry failure heals on the next " +
          `run; if ${c.name} lives on a private registry, add it to the ` +
          "minimum_release_age_exclude input (minimum_release_age: 0 disables the " +
          "cooldown entirely).",
        packages: statusPackages([c]),
        verification: [],
        prUrl: null,
      });
    }

    let requiresReset = false;
    let prepared = 0;
    // Distinct group keys can slugify to the same branch (slugify strips `@`
    // and maps `/` to `-`, so `prod/@babel/core` and `prod/babel-core`
    // collide). Branch = PR identity, and processing a collider would
    // ensureBranch-reset the earlier group's commits away — fail closed on
    // every branch seen this run, whatever its disposition.
    const seenBranches = new Set<string>();

    try {
      for (const group of groups) {
        const members = group.members;
        const pkgList = members.map((m) => m.name).join(", ");
        const branch = branchNameForGroup(group.key);
        const packages = statusPackages(members);
        const record = (status: string, summary: string): void =>
          recordGroup({
            status,
            branch,
            group: group.key,
            summary,
            packages,
            verification: [],
            prUrl: null,
          });

        if (seenBranches.has(branch)) {
          record(
            "branch-collision",
            `Group '${group.key}' maps to branch '${branch}', which another group in ` +
              "this run already uses (their names collide after slugification). Refusing " +
              "to process it so the other group's branch and PR are not overwritten.",
          );
          continue;
        }
        seenBranches.add(branch);

        const hasOpenPr = bodyByBranch.has(branch);
        // Compare only the body's TRAILING marker (where buildPrPayload writes
        // it), never a substring search: a marker-shaped string can survive
        // sanitizing inside a code span mid-body, and an includes() over the
        // whole body would let such narrative pin this group as up to date.
        const upToDate =
          extractVersionsMarker(bodyByBranch.get(branch) ?? "") === versionsMarker(members);
        const disposition = classifyGroup({ hasOpenPr, upToDate, newSlots });

        if (disposition === "skip-up-to-date") {
          // An open PR on this branch already covers exactly these target
          // versions. It occupies a slot but needs no work.
          record(
            "pr-up-to-date",
            `Open PR on ${branch} already covers ${pkgList} at the current target versions; skipped.`,
          );
          continue;
        }
        if (disposition === "held-back") {
          // The ceiling is reached for a NEW PR; refreshes were classified
          // separately above and are never held back.
          record(
            "held-back-by-limit",
            `Held back: the open_pull_requests_limit=${openPullRequestsLimit} ceiling on open PRs is already reached. This group is opened once a slot frees (an existing depvisor PR is merged or closed).`,
          );
          continue;
        }

        const outcome = await processGroup({
          repo: REPO,
          group,
          branch,
          base,
          verifySteps,
          pm,
          resetCommand,
          requiresResetBefore: requiresReset,
          minimumReleaseAge,
          suggestFeatures,
          language,
          disposition,
          packuments,
          advisories,
          harness,
          log,
        });

        if (outcome.kind === "stop") {
          run.status = outcome.status;
          run.summary = outcome.summary;
          break;
        }
        requiresReset = outcome.requiresResetNext;
        if (outcome.kind === "prepared") {
          // Compose/verification is complete, but payload ordering and the
          // incremental status record remain cross-group concerns. A newly
          // prepared PR consumes a slot; refreshing an existing one does not.
          const payloadPath = emitPrPayload(PR_OUT_DIR, outcome.payload, prepared);
          prepared += 1;
          log.info(`PR payload emitted: ${payloadPath}`);
          recordGroup(outcome.result);
          if (outcome.consumedSlot) newSlots -= 1;
          continue;
        }
        recordGroup(outcome.result);
      }
    } finally {
      // Leave the checkout back on base so the next run never chains off an
      // update branch. A dirty tree, e.g. after failed verification, stays on
      // the branch for inspection.
      if (isClean(REPO)) tryCheckout(REPO, base);
    }

    // Graceful end of the loop: upgrade the crash marker to the real outcome.
    // Run-level stops (baseline-red, reset-failed) already set their status.
    // The release-age and OSV-unavailable notes ride along so cooldown
    // clamps/hold-backs and a degraded security prioritization are visible in
    // the summary rather than silent.
    if (run.status === "in-progress") {
      run.status = "completed";
      run.summary = [summarizeRun(run), releaseAgeNote, osvUnavailableNote]
        .filter(Boolean)
        .join(" ");
    }
    return finish(run);
  },
});
