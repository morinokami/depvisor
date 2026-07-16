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
