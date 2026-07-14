import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FlueError, ResultUnavailableError, defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import depvisor from "../agents/depvisor.ts";
import {
  AgentArtifactSchema,
  AnalysisArtifactSchema,
  FixerReportSchema,
  ReviewerReportSchema,
  VerificationArtifactSchema,
  readArtifact,
  writeArtifact,
  type AgentArtifact,
} from "../core/artifacts.ts";
import { fixerPrompt, reviewerPrompt } from "../agents/shared/tasks.ts";
import type { UsageEntry } from "../core/types.ts";

const InputSchema = v.object({ role: v.picklist(["fixer", "reviewer"]) });

function usage(
  role: UsageEntry["role"],
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
): UsageEntry {
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

function unavailableUsage(role: UsageEntry["role"]): UsageEntry {
  return {
    role,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    model: "unavailable",
  };
}

export default defineWorkflow({
  agent: depvisor,
  input: InputSchema,
  output: AgentArtifactSchema,
  async run({ harness, input, log }): Promise<AgentArtifact> {
    const directory = process.env.DEPVISOR_ARTIFACT_DIR || "run";
    mkdirSync(directory, { recursive: true });
    const analysis = readArtifact(
      process.env.DEPVISOR_ANALYSIS_FILE || join(directory, "analysis.json"),
      AnalysisArtifactSchema,
    );
    const session = await harness.session(`pr-${analysis.resolved.target.number}-${input.role}`);
    let artifact: AgentArtifact;
    if (input.role === "reviewer") {
      try {
        const response = await session.task(reviewerPrompt(analysis), {
          agent: "reviewer",
          result: ReviewerReportSchema,
        });
        artifact = {
          schemaVersion: 2,
          role: "reviewer",
          report: v.parse(ReviewerReportSchema, response.data),
          usage: usage("reviewer", response),
        };
      } catch (error) {
        if (
          !(
            error instanceof FlueError ||
            error instanceof ResultUnavailableError ||
            error instanceof v.ValiError
          )
        )
          throw error;
        log.warn("Reviewer failed softly; deterministic facts will still be published.");
        artifact = {
          schemaVersion: 2,
          role: "reviewer",
          report: {
            summary:
              "The narrative reviewer was unavailable; see normalized changes and verification facts.",
            upstream_changes: [],
            observed_usage: [],
            confirmed_risks: [],
            inferred_risks: [],
            reviewer_checks: [],
            evidence: [],
          },
          usage: unavailableUsage("reviewer"),
        };
      }
    } else {
      const head = readArtifact(
        process.env.DEPVISOR_HEAD_VERIFICATION_FILE || join(directory, "head.json"),
        VerificationArtifactSchema,
      );
      try {
        const response = await session.task(fixerPrompt(analysis, head), {
          agent: "fixer",
          result: FixerReportSchema,
        });
        artifact = {
          schemaVersion: 2,
          role: "fixer",
          report: v.parse(FixerReportSchema, response.data),
          usage: usage("fixer", response),
        };
      } catch (error) {
        if (
          !(
            error instanceof FlueError ||
            error instanceof ResultUnavailableError ||
            error instanceof v.ValiError
          )
        )
          throw error;
        artifact = {
          schemaVersion: 2,
          role: "fixer",
          report: {
            summary: "The fixer did not return a usable structured result.",
            fixes_applied: [],
            residual_risks: [],
            verdict: "defer",
            defer_reason: "No structured fixer result was available.",
          },
          usage: unavailableUsage("fixer"),
        };
      }
    }
    writeArtifact(
      process.env.DEPVISOR_AGENT_OUTPUT || join(directory, `${input.role}.json`),
      AgentArtifactSchema,
      artifact,
    );
    return artifact;
  },
});
