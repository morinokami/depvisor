import { readFileSync, writeFileSync } from "node:fs";
import type { AgentResult } from "./agent-result.ts";
import type { RepairChanges } from "./git.ts";
import { isRecord } from "./json.ts";

export interface RepairPayload {
  version: 2;
  repository: string;
  prNumber: number;
  prUrl: string;
  headRepository: string;
  headRef: string;
  headSha: string;
  agent: AgentResult;
  changes: RepairChanges;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid repair payload: ${label}`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid repair payload: ${label}`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid repair payload: ${label}`);
  if (value.length > 200) throw new Error(`Invalid repair payload: ${label} is too large`);
  return value.map((entry) => string(entry, label));
}

function agentResult(value: unknown): AgentResult {
  const agent = record(value, "agent");
  if (agent.verdict !== "ready" && agent.verdict !== "defer") {
    throw new Error("Invalid repair payload: agent.verdict");
  }
  if (!Array.isArray(agent.upstream_changes) || !Array.isArray(agent.verification)) {
    throw new Error("Invalid repair payload: agent evidence");
  }
  if (agent.upstream_changes.length > 100 || agent.verification.length > 100) {
    throw new Error("Invalid repair payload: too many evidence entries");
  }
  const result: AgentResult = {
    verdict: agent.verdict,
    summary: string(agent.summary, "agent.summary"),
    upstream_changes: agent.upstream_changes.map((rawChange) => {
      const item = record(rawChange, "agent.upstream_changes[]");
      const parsed: AgentResult["upstream_changes"][number] = {
        dependency: string(item.dependency, "upstream dependency"),
        change: string(item.change, "upstream change"),
        relevance: string(item.relevance, "upstream relevance"),
      };
      if (typeof item.evidence_url === "string") parsed.evidence_url = item.evidence_url;
      return parsed;
    }),
    changes_made: strings(agent.changes_made, "agent.changes_made"),
    verification: agent.verification.map((rawVerification) => {
      const item = record(rawVerification, "agent.verification[]");
      if (item.outcome !== "passed" && item.outcome !== "failed" && item.outcome !== "not-run") {
        throw new Error("Invalid repair payload: verification outcome");
      }
      return {
        command: string(item.command, "verification command"),
        outcome: item.outcome,
        evidence: string(item.evidence, "verification evidence"),
      };
    }),
    risks: strings(agent.risks, "agent.risks"),
  };
  if (typeof agent.defer_reason === "string") result.defer_reason = agent.defer_reason;
  if (result.verdict === "defer" && !result.defer_reason?.trim()) {
    throw new Error("Invalid repair payload: defer_reason is required");
  }
  return result;
}

function repairChanges(value: unknown): RepairChanges {
  const changes = record(value, "changes");
  if (!Array.isArray(changes.newFiles)) throw new Error("Invalid repair payload: newFiles");
  if (changes.newFiles.length > 200) throw new Error("Invalid repair payload: too many new files");
  return {
    patch: string(changes.patch, "changes.patch"),
    paths: strings(changes.paths, "changes.paths"),
    newFiles: changes.newFiles.map((rawFile) => {
      const file = record(rawFile, "changes.newFiles[]");
      if (typeof file.executable !== "boolean" || typeof file.symlink !== "boolean") {
        throw new Error("Invalid repair payload: new file flags");
      }
      return {
        path: string(file.path, "new file path"),
        contentBase64: string(file.contentBase64, "new file content"),
        executable: file.executable,
        symlink: file.symlink,
      };
    }),
  };
}

export function writeRepairPayload(path: string, payload: RepairPayload): void {
  writeFileSync(path, JSON.stringify(payload));
}

export function readRepairPayload(path: string): RepairPayload {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > 10 * 1024 * 1024) {
    throw new Error("Invalid repair payload: file is too large");
  }
  const root = record(JSON.parse(text), "root");
  const prNumber = root.prNumber;
  const headSha = string(root.headSha, "headSha");
  if (
    root.version !== 2 ||
    typeof prNumber !== "number" ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !/^[0-9a-f]{40}$/.test(headSha)
  ) {
    throw new Error("Invalid repair payload identity");
  }
  return {
    version: 2,
    repository: string(root.repository, "repository"),
    prNumber,
    prUrl: string(root.prUrl, "prUrl"),
    headRepository: string(root.headRepository, "headRepository"),
    headRef: string(root.headRef, "headRef"),
    headSha,
    agent: agentResult(root.agent),
    changes: repairChanges(root.changes),
  };
}
