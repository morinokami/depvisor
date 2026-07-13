/**
 * Token-holding Action entrypoint that snapshots open PRs before any target
 * lifecycle script runs. The initial list is fail-closed because an incomplete
 * snapshot could silently exceed open_pull_requests_limit. Per-PR REST polling
 * is fail-soft because mergeability is an optimization: unresolved UNKNOWN is
 * carried into the token-free workflow for an honest skip summary.
 *
 * Usage (normally action.yml):
 *   DEPVISOR_REPOSITORY=owner/repo DEPVISOR_OPEN_PRS_FILE=/path/open-prs.json
 *   GH_TOKEN=... node src/snapshot-open-prs.ts
 */

import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pollUnknownMergeability } from "./core/open-pr-poll.ts";
import { parseOpenPrSnapshot, type SnapshotPrFields } from "./core/open-pr-snapshot.ts";
import { buildSecureEnv, runSecureGh } from "./core/github.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function repositoryIdentifier(raw: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    throw new Error("DEPVISOR_REPOSITORY must be an owner/repository identifier");
  }
  return raw;
}

function apiBase(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("DEPVISOR_API_URL must be a plain HTTPS API base URL");
  }
  return url.href.replace(/\/$/, "");
}

function snapshotFields(value: unknown): SnapshotPrFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields: SnapshotPrFields = {};
  if ("number" in value && typeof value.number === "number") fields.number = value.number;
  if ("headRefName" in value && typeof value.headRefName === "string") {
    fields.headRefName = value.headRefName;
  }
  if ("body" in value && typeof value.body === "string") fields.body = value.body;
  if ("mergeable" in value && typeof value.mergeable === "string") {
    fields.mergeable = value.mergeable;
  }
  if ("mergeStateStatus" in value && typeof value.mergeStateStatus === "string") {
    fields.mergeStateStatus = value.mergeStateStatus;
  }
  return fields;
}

async function main(): Promise<void> {
  const repository = repositoryIdentifier(required("DEPVISOR_REPOSITORY"));
  const output = required("DEPVISOR_OPEN_PRS_FILE");
  const token = required("GH_TOKEN");
  const api = apiBase(process.env.DEPVISOR_API_URL?.trim() || "https://api.github.com");
  const workDir = mkdtempSync(join(tmpdir(), "depvisor-snapshot-"));
  const home = join(workDir, "home");
  mkdirSync(home);

  try {
    const env = buildSecureEnv(home);
    const listed = runSecureGh(env, process.cwd(), [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,headRefName,body,mergeable,mergeStateStatus",
    ]);
    if (listed.code !== 0) {
      throw new Error(`could not snapshot open PRs: ${listed.err || "gh pr list failed"}`);
    }
    const raw: unknown = JSON.parse(listed.out);
    if (!Array.isArray(raw)) {
      throw new Error("could not snapshot open PRs: gh pr list returned a non-array result");
    }
    // Validate the list before polling, but keep the external vocabulary in the
    // file so the token-free reader remains the single semantic normalizer.
    const normalized = parseOpenPrSnapshot(raw);
    if (normalized.length !== raw.length) {
      throw new Error("could not snapshot open PRs: gh pr list returned an invalid PR entry");
    }
    const validBranches = new Set(normalized.map((entry) => entry.headRefName));
    const entries: SnapshotPrFields[] = raw.flatMap((entry) => {
      const fields = snapshotFields(entry);
      return fields?.headRefName && validBranches.has(fields.headRefName) ? [fields] : [];
    });

    const polled = await pollUnknownMergeability(entries, async (number, timeoutMs) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${api}/repos/${repository}/pulls/${number}`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`GitHub REST returned ${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timeout);
      }
    });

    mkdirSync(dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(polled)}\n`, { mode: 0o600 });
    renameSync(temporary, output);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
