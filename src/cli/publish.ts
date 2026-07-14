/** Fresh-job publisher: compare-and-swap push plus check/comment publication. */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  AgentArtifactSchema,
  AnalysisArtifactSchema,
  CandidateArtifactSchema,
  FixerReportSchema,
  ReviewerReportSchema,
  VerificationArtifactSchema,
  readArtifact,
  writeArtifact,
  type AgentArtifact,
  type VerificationArtifact,
} from "../core/artifacts.ts";
import {
  AGENT_AUTHOR,
  AGENT_EMAIL,
  AGENT_NAME,
  patchHash,
  repairCommitMessage,
  runGit,
} from "../core/git.ts";
import { renderReport, REPORT_MARKER } from "../core/report.ts";
import { classifyResult } from "../core/result.ts";
import { checkScopePaths, validatePatchEnvelope } from "../core/scope.ts";
import { statusClass, statusFailsJob } from "../core/status.ts";
import type { UsageEntry } from "../core/types.ts";
import { V2ResultSchema } from "../core/types.ts";
import { GitHubClient } from "../github/client.ts";
import { adapterFor, admitProvider } from "../providers/index.ts";
import { setGitHubOutput } from "./github-output.ts";

const directory = process.env.DEPVISOR_ARTIFACT_DIR || "run";
mkdirSync(directory, { recursive: true });

function optional<TSchema extends v.GenericSchema>(
  name: string,
  schema: TSchema,
): v.InferOutput<TSchema> | null {
  const path = join(directory, `${name}.json`);
  return existsSync(path) ? readArtifact(path, schema) : null;
}

function secureGitEnvironment(token: string, home: string, askpass: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass,
    DEPVISOR_PUSH_TOKEN: token,
    LANG: "C.UTF-8",
  };
}

function checkedGit(repo: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  const result = runGit(repo, args, input === undefined ? { env } : { env, input });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.err}`);
  return result.out.trim();
}

function checkedGitRaw(
  repo: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): string {
  const result = runGit(repo, args, input === undefined ? { env } : { env, input });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.err}`);
  return result.out;
}

function publishPatch(
  analysis: v.InferOutput<typeof AnalysisArtifactSchema>,
  patch: string,
  token: string,
): string {
  const root = mkdtempSync(join(tmpdir(), "depvisor-publish-"));
  const home = join(root, "home");
  const clone = join(root, "repo");
  mkdirSync(home, { recursive: true });
  const askpass = join(root, "askpass.sh");
  writeFileSync(
    askpass,
    "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' x-access-token;; *) printf '%s\\n' \"$DEPVISOR_PUSH_TOKEN\";; esac\n",
    { mode: 0o700 },
  );
  chmodSync(askpass, 0o700);
  const env = secureGitEnvironment(token, home, askpass);
  const target = analysis.resolved.target;
  if (target.headRepository.toLowerCase() !== target.repository.toLowerCase()) {
    throw new Error("publisher refuses a cross-repository updater branch");
  }
  checkedGit(
    root,
    [
      "clone",
      "--no-tags",
      "--filter=blob:none",
      `https://github.com/${target.repository}.git`,
      clone,
    ],
    env,
  );
  checkedGit(clone, ["checkout", "--detach", target.prHeadSha], env);
  if (checkedGit(clone, ["rev-parse", "HEAD"], env) !== target.prHeadSha) {
    throw new Error("fresh clone did not resolve the analyzed PR head");
  }
  checkedGit(clone, ["apply", "--whitespace=nowarn", "-"], env, patch);
  const rawPaths = checkedGitRaw(clone, ["diff", "--name-only", "--no-renames", "-z"], env);
  const paths = rawPaths.split("\0").filter(Boolean);
  const scope = checkScopePaths(paths, analysis.protectedPaths);
  if (!scope.ok) throw new Error(`publisher scope gate failed: ${scope.violations.join(", ")}`);
  const appliedPatch = checkedGitRaw(
    clone,
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      target.prHeadSha,
    ],
    env,
  );
  if (patchHash(appliedPatch) !== patchHash(patch)) {
    throw new Error("fresh-clone patch differs from the verified candidate");
  }
  checkedGit(clone, ["add", "-A"], env);
  const adapter = adapterFor(target.provider);
  checkedGit(
    clone,
    [
      "-c",
      `user.email=${AGENT_EMAIL}`,
      "-c",
      `user.name=${AGENT_NAME}`,
      "commit",
      `--author=${AGENT_AUTHOR}`,
      "-m",
      repairCommitMessage(target.updaterHeadSha, adapter.repairCommitSuffix),
    ],
    env,
  );
  const sha = checkedGit(clone, ["rev-parse", "HEAD"], env);
  checkedGit(clone, ["push", "origin", `HEAD:refs/heads/${target.headRef}`], env);
  return sha;
}

async function main(): Promise<void> {
  const analysis = readArtifact(
    process.env.DEPVISOR_ANALYSIS_FILE || join(directory, "analysis.json"),
    AnalysisArtifactSchema,
  );
  const baseline = optional("baseline", VerificationArtifactSchema);
  const head = optional("head", VerificationArtifactSchema);
  const candidate = optional("candidate", CandidateArtifactSchema);
  const candidateVerification = optional("candidate-verification", VerificationArtifactSchema);
  const reviewerArtifact = optional("reviewer", AgentArtifactSchema);
  const fixerArtifact = optional("fixer", AgentArtifactSchema);
  const reviewer =
    reviewerArtifact?.role === "reviewer"
      ? v.parse(ReviewerReportSchema, reviewerArtifact.report)
      : null;
  const fixer =
    fixerArtifact?.role === "fixer" ? v.parse(FixerReportSchema, fixerArtifact.report) : null;
  const usage: UsageEntry[] = [reviewerArtifact, fixerArtifact]
    .filter((artifact): artifact is AgentArtifact => artifact !== null)
    .map((artifact) => artifact.usage);

  let decision = classifyResult(analysis, baseline, head, candidate, candidateVerification);
  const token = process.env.DEPVISOR_PUBLISH_TOKEN || "";
  if (!token) throw new Error("DEPVISOR_PUBLISH_TOKEN is required in the publisher job");
  const client = new GitHubClient(token);
  const target = analysis.resolved.target;
  const currentRepositoryId = await client.repositoryId(target.repository);
  const current = await client.pull(target.repository, target.number);
  if (
    currentRepositoryId !== target.repositoryId ||
    current.state !== "open" ||
    current.base.sha !== target.baseTipSha ||
    current.base.ref !== target.baseRef ||
    current.base.repo.full_name.toLowerCase() !== target.repository.toLowerCase()
  )
    decision = { status: "stale-base", pushCandidate: false };
  else if (
    current.head.sha !== target.prHeadSha ||
    current.head.ref !== target.headRef ||
    current.head.repo?.full_name.toLowerCase() !== target.headRepository.toLowerCase()
  )
    decision = { status: "stale-head", pushCandidate: false };

  const currentCommits = await client.commits(target.repository, target.number);
  const admission = admitProvider(
    {
      actor: current.user,
      headRepository: current.head.repo?.full_name ?? "",
      baseRepository: current.base.repo.full_name,
      headRef: current.head.ref,
    },
    currentCommits,
    analysis.resolved.config,
  );
  if (admission.status !== null || admission.updaterHeadSha !== target.updaterHeadSha) {
    decision = {
      status: admission.status === "human-takeover" ? "human-takeover" : "stale-head",
      pushCandidate: false,
    };
  }

  let publishedHeadSha: string | null = null;
  if (decision.pushCandidate) {
    if (!candidate || candidate.verdict !== "candidate")
      throw new Error("approved patch is absent");
    if (
      !validatePatchEnvelope(candidate.patch).ok ||
      patchHash(candidate.patch) !== candidate.patchHash
    ) {
      decision = { status: "scope-violation", pushCandidate: false };
    } else {
      try {
        publishedHeadSha = publishPatch(analysis, candidate.patch, token);
      } catch (error) {
        process.stderr.write(`${Error.isError(error) ? error.message : String(error)}\n`);
        decision = { status: "publish-failed", pushCandidate: false };
      }
    }
  } else if (decision.status === "updater-refresh-requested") {
    try {
      const requested = await client.applyRefresh(
        target.repository,
        target.number,
        analysis.resolved.refresh,
      );
      if (!requested) decision = { status: "updater-refresh-required", pushCandidate: false };
    } catch {
      decision = { status: "publish-failed", pushCandidate: false };
    }
  }

  const verification = [baseline, head, candidateVerification].filter(
    (artifact): artifact is VerificationArtifact => artifact !== null,
  );
  const report = renderReport(
    decision.status,
    analysis,
    reviewer,
    fixer,
    verification,
    publishedHeadSha,
    candidate?.paths ?? [],
  );
  let reportUrl: string | null = null;
  try {
    const reportHead = publishedHeadSha ?? target.prHeadSha;
    reportUrl = await client.upsertComment(target.repository, target.number, REPORT_MARKER, report);
    const klass = statusClass(decision.status);
    await client.createCheck(
      target.repository,
      reportHead,
      klass === "green" ? "success" : klass === "neutral" ? "neutral" : "failure",
      `depvisor: ${decision.status}`,
      report,
    );
  } catch (error) {
    process.stderr.write(
      `report publication failed: ${Error.isError(error) ? error.message : String(error)}\n`,
    );
    if (
      decision.status !== "stale-base" &&
      decision.status !== "stale-head" &&
      decision.status !== "human-takeover"
    ) {
      decision = { status: "publish-failed", pushCandidate: false };
    }
  }

  const result = {
    status: decision.status,
    pr: target.number,
    analyzedBaseTipSha: target.baseTipSha,
    analyzedPrHeadSha: target.prHeadSha,
    updaterHeadSha: target.updaterHeadSha,
    publishedHeadSha,
    provider: target.provider,
    changes: analysis.changes,
    repairApplied:
      publishedHeadSha !== null ||
      (analysis.resolved.existingRepair && decision.status === "repair-applied"),
    verification: verification.flatMap((artifact) => artifact.results),
    reportUrl,
    usage,
  };
  writeArtifact(join(directory, "result.json"), V2ResultSchema, result);
  setGitHubOutput("status", decision.status);
  setGitHubOutput("failed", statusFailsJob(decision.status));
  setGitHubOutput("repair_applied", result.repairApplied);
  setGitHubOutput("pr", target.number);
  setGitHubOutput("published_head", publishedHeadSha ?? "");
  if (statusFailsJob(decision.status)) process.exitCode = 1;
}

await main();
