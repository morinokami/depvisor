import { fileURLToPath } from "node:url";
import { defineWorkflow } from "@flue/runtime";
import depvisor from "../agents/depvisor.ts";
import { parseRunConfig } from "../core/config.ts";
import { classifyPrCommits, diffDependencies } from "../core/dep-diff.ts";
import { isClean, tryCheckout } from "../core/git.ts";
import { preflight, resolveResetCommand } from "../core/preflight.ts";
import { clearPrPreview, emitReportPayload } from "../core/report.ts";
import {
  emitRunStatus,
  emptyRunStatus,
  RUN_OUTPUT_SCHEMA,
  runFailsJob,
  runLogLine,
  toRunOutput,
  type RunStatus,
} from "../core/status.ts";
import { REPO } from "../shared/target.ts";
import { processPr } from "./aftercare/process-pr.ts";

const PR_OUT_DIR = fileURLToPath(new URL("../../pr-preview", import.meta.url));

/**
 * The aftercare workflow (`flue run aftercare`): consume one updater PR —
 * checked out at its head — and turn it into a green, reviewable PR without
 * taking ownership of dependency selection or PR lifecycle from the updater.
 * It verifies deterministically, attributes failures against the merge base,
 * delegates only the bounded fixer/digest roles to the LLM, and stops at the
 * emitted publish payload; the token-holding publish step does the rest.
 */
export default defineWorkflow({
  agent: depvisor,
  // The status shape is single-sourced in core/status.ts; toRunOutput below is
  // the projector derived from this same schema.
  output: RUN_OUTPUT_SCHEMA,

  async run({ harness, log }) {
    // Deterministic pre-agent cleanup so a stale payload from a previous local
    // run cannot be published and the incremental status stays consistent.
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
    //    statuses therefore carry no resolved refs.
    const parsedConfig = parseRunConfig(process.env);
    if (!parsedConfig.ok) {
      return finish(emptyRunStatus(parsedConfig.status, parsedConfig.summary));
    }
    const config = parsedConfig.config;

    const pre = preflight(REPO, {
      baseRef: config.baseRef,
      headRef: config.headRef,
      verifyCommands: config.verifyCommands,
    });
    if (!pre.ok) {
      return finish({
        ...emptyRunStatus(pre.status, pre.summary),
        baseRef: config.baseRef,
        prNumber: config.prNumber ?? null,
      });
    }
    const { headRef, headSha, mergeBaseSha, verifySteps, pm } = pre;
    const resetCommand = resolveResetCommand(pm, REPO, config.installCommand);
    log.info(
      `preflight ok: pm=${pm.name}, pr=#${config.prNumber ?? "?"}, head=${headRef}@${headSha.slice(0, 8)}, ` +
        `base=${config.baseRef}, merge-base=${mergeBaseSha.slice(0, 8)}, ` +
        `verify steps: ${verifySteps.map((s) => s.name).join(", ")}`,
    );

    // Everything after this point mutates node_modules or the tree, so the run
    // starts as `in-progress` — a job-failing status — and only a graceful
    // finish upgrades it. If the process dies mid-run, the last incremental
    // write is what report-status reads, and it must fail the job instead of
    // impersonating a green run.
    const run: RunStatus = {
      ...emptyRunStatus(
        "in-progress",
        "The run was interrupted before it finished analyzing this PR.",
      ),
      baseRef: config.baseRef,
      headRef,
      headSha,
      prNumber: config.prNumber ?? null,
    };
    emitRunStatus(PR_OUT_DIR, run);

    try {
      // 1. Is this a pure dependency-update PR at all? Every commit beyond the
      //    merge base must be dependency-state-only (the updater's work) or a
      //    previous depvisor repair. Anything else means a human owns work on
      //    this branch, and depvisor must not build a repair on it — a green
      //    skip, because human takeover of an updater branch is expected.
      if (mergeBaseSha === headSha) {
        run.status = "not-an-update-pr";
        run.summary = `This PR adds no commits beyond '${config.baseRef}'; nothing to analyze.`;
        return finish(run);
      }
      const commits = classifyPrCommits(REPO, mergeBaseSha, headSha);
      if (!commits.ok) {
        const first = commits.foreign[0];
        run.status = "not-an-update-pr";
        run.summary =
          `Commit ${first?.sha.slice(0, 8)} touches non-dependency paths ` +
          `(${first?.paths.slice(0, 5).join(", ")}${(first?.paths.length ?? 0) > 5 ? ", …" : ""}), ` +
          "so this is not a pure dependency-update PR — a human owns work on this branch. " +
          "depvisor analyzes and repairs only updater-authored dependency changes; skipped.";
        return finish(run);
      }

      // 2. Name the dependency change deterministically from the committed
      //    diff (lockfile-resolved when the lockfile parses).
      const depDiff = diffDependencies(REPO, mergeBaseSha, headSha, pm);
      run.changes = depDiff.direct;
      emitRunStatus(PR_OUT_DIR, run);
      if (depDiff.direct.length === 0 && depDiff.transitives.length === 0) {
        run.status = "not-an-update-pr";
        run.summary =
          "The PR's commits change no dependency depvisor can name (no manifest or " +
          "lockfile resolution moved); nothing to analyze.";
        return finish(run);
      }
      log.info(
        `dependency change: ${depDiff.direct.map((c) => `${c.name} ${c.from}->${c.to}`).join(", ") || "(none direct)"}` +
          (depDiff.transitives.length > 0 ? ` + ${depDiff.transitives.length} transitive` : "") +
          (depDiff.lockfileResolved ? "" : " (manifest specifiers; lockfile not parsed)"),
      );

      // 3. Verify → attribute → repair → report.
      const outcome = await processPr({
        repo: REPO,
        headRef,
        headSha,
        mergeBaseSha,
        baseRef: config.baseRef,
        prNumber: config.prNumber,
        depDiff,
        verifySteps,
        pm,
        resetCommand,
        language: config.language,
        harness,
        log,
      });

      run.status = outcome.status;
      run.summary = outcome.summary;
      run.verification = outcome.verification;
      if (outcome.usage.length > 0) run.usage = outcome.usage;
      if (outcome.kind === "prepared") {
        run.repaired = outcome.repaired;
        if (outcome.testChanges.length > 0) run.testChanges = outcome.testChanges;
        const payloadPath = emitReportPayload(PR_OUT_DIR, outcome.payload);
        log.info(`publish payload emitted: ${payloadPath}`);
      }
      return finish(run);
    } finally {
      // Leave the checkout back on the head branch so the next run never
      // chains off a detached baseline state. A dirty tree, e.g. after a
      // crash, stays put for inspection.
      if (isClean(REPO)) tryCheckout(REPO, headRef);
    }
  },
});
