/** Trusted coordinator: resolve one workflow run/PR and attest its provider. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ResolveArtifactSchema, writeArtifact, type ResolveArtifact } from "../core/artifacts.ts";
import { parseConfig } from "../core/config.ts";
import { GitHubClient, type GitHubPullRequest } from "../github/client.ts";
import { admitProvider } from "../providers/index.ts";
import { statusFailsJob } from "../core/status.ts";
import { setGitHubOutput } from "./github-output.ts";

function positiveInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function artifactPath(): string {
  const directory = process.env.DEPVISOR_ARTIFACT_DIR || "run";
  mkdirSync(directory, { recursive: true });
  return join(directory, "resolve.json");
}

function finish(artifact: ResolveArtifact): void {
  writeArtifact(artifactPath(), ResolveArtifactSchema, artifact);
  setGitHubOutput("admitted", artifact.resolved !== null);
  setGitHubOutput("status", artifact.terminalStatus ?? "in-progress");
  if (artifact.resolved) {
    setGitHubOutput("pr", artifact.resolved.target.number);
    setGitHubOutput("base_tip", artifact.resolved.target.baseTipSha);
    setGitHubOutput("pr_head", artifact.resolved.target.prHeadSha);
    setGitHubOutput("updater_head", artifact.resolved.target.updaterHeadSha);
    setGitHubOutput("head_repository", artifact.resolved.target.headRepository);
    setGitHubOutput("trigger_conclusion", artifact.resolved.triggerConclusion ?? "manual");
  }
}

function terminal(status: ResolveArtifact["terminalStatus"], summary: string): never {
  finish({ schemaVersion: 2, terminalStatus: status, summary, resolved: null });
  process.exit(status !== null && statusFailsJob(status) ? 1 : 0);
}

async function resolvePull(
  client: GitHubClient,
  repository: string,
): Promise<{ pull: GitHubPullRequest; conclusion: string | null }> {
  const prNumber = positiveInteger(process.env.DEPVISOR_PR_NUMBER);
  if (prNumber !== null) return { pull: await client.pull(repository, prNumber), conclusion: null };
  const runId = positiveInteger(process.env.DEPVISOR_WORKFLOW_RUN_ID);
  if (runId === null) terminal("no-target", "No workflow_run_id or manual PR number was provided.");
  const run = await client.workflowRun(repository, runId);
  const pulls = await client.pullsForHeadSha(repository, run.headSha);
  if (pulls.length !== 1) {
    terminal(
      "no-target",
      `Workflow head ${run.headSha} resolved to ${pulls.length} open pull requests.`,
    );
  }
  return { pull: pulls[0]!, conclusion: run.conclusion };
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  const client = new GitHubClient(process.env.GITHUB_TOKEN || "");
  const { pull, conclusion } = await resolvePull(client, repository);
  if (pull.state !== "open" || pull.head.repo === null) {
    terminal("no-target", "The resolved pull request is not open or its head repository is gone.");
  }

  const configSource = await client.fileAtRef(repository, ".github/depvisor.yml", pull.base.sha);
  const parsedConfig = parseConfig(configSource);
  if (!parsedConfig.ok) {
    if (pull.user.type === "User") {
      terminal(
        "not-updater",
        "The pull request was opened by an ordinary user and no valid base-tip config attests it as a self-hosted updater.",
      );
    }
    terminal("bad-config", parsedConfig.error);
  }

  const commits = await client.commits(repository, pull.number);
  if (commits.at(-1)?.sha !== pull.head.sha) {
    terminal("stale-head", "The PR head moved while its commit chain was being resolved.");
  }
  const admission = admitProvider(
    {
      actor: pull.user,
      headRepository: pull.head.repo.full_name,
      baseRepository: pull.base.repo.full_name,
      headRef: pull.head.ref,
    },
    commits,
    parsedConfig.config,
  );
  if (
    admission.status !== null ||
    admission.provider === null ||
    admission.updaterHeadSha === null
  ) {
    terminal(admission.status ?? "untrusted-updater", admission.summary);
  }

  const inRepository =
    pull.head.repo.full_name.toLowerCase() === pull.base.repo.full_name.toLowerCase();
  const mergeBaseSha = await client.mergeBase(repository, pull.base.sha, admission.updaterHeadSha);
  const target = {
    repositoryId: await client.repositoryId(repository),
    repository,
    number: pull.number,
    baseRef: pull.base.ref,
    baseTipSha: pull.base.sha,
    mergeBaseSha,
    prHeadSha: pull.head.sha,
    updaterHeadSha: admission.updaterHeadSha,
    headRepository: pull.head.repo.full_name,
    headRef: pull.head.ref,
    provider: admission.provider,
  };
  finish({
    schemaVersion: 2,
    terminalStatus: null,
    summary: admission.summary,
    resolved: {
      target,
      config: parsedConfig.config,
      configDigest: parsedConfig.digest,
      triggerConclusion: conclusion,
      existingRepair: admission.existingRepair,
      inRepository,
      refresh: admission.refresh!,
    },
  });
}

await main();
