/** Minimal GitHub REST client shared by the token-holding entrypoints. */

import { isRecord } from "../core/json.ts";
import { required } from "./env.ts";

export function apiBase(): string {
  return (process.env.DEPVISOR_API_URL || "https://api.github.com").replace(/\/$/, "");
}

export function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${required("GH_TOKEN")}`,
    "User-Agent": "depvisor-v2",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function github(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const init: RequestInit = {
    method: options.method || "GET",
    headers: githubHeaders(),
  };
  if (options.body !== undefined) {
    init.headers = { ...githubHeaders(), "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${apiBase()}${path}`, init);
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
  return response.json();
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`GitHub returned an invalid ${label}`);
  }
  return value;
}

/** Download one workflow-job log and keep only its bounded tail. */
export async function downloadJobLog(
  repository: string,
  jobId: number,
  maxChars: number,
): Promise<string> {
  const first = await fetch(`${apiBase()}/repos/${repository}/actions/jobs/${jobId}/logs`, {
    redirect: "manual",
    headers: githubHeaders(),
  });
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) return "(job log redirect had no location)";
    const response = await fetch(location);
    if (!response.ok) return `(job log download returned ${response.status})`;
    return (await response.text()).slice(-maxChars);
  }
  if (!first.ok) return `(job log unavailable: ${first.status})`;
  return (await first.text()).slice(-maxChars);
}

export interface MarkerComment {
  id: number;
  body: string;
  htmlUrl: string;
}

/** Find the newest PR comment containing `marker`, scanning up to 1,000 comments. */
export async function latestMarkerComment(
  repository: string,
  prNumber: number,
  marker: string,
): Promise<MarkerComment | null> {
  const comments: unknown[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await github(
      `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid PR comment list");
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  for (const value of comments.toReversed()) {
    if (!isRecord(value) || typeof value.body !== "string" || !value.body.includes(marker)) {
      continue;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) continue;
    return {
      id: value.id,
      body: value.body,
      htmlUrl: typeof value.html_url === "string" ? value.html_url : "",
    };
  }
  return null;
}
