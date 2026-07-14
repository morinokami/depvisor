/** Minimal read-only GitHub REST client for the trusted resolver job. */

import * as v from "valibot";
import { GitShaSchema } from "../core/types.ts";
import type { GitHubCommitIdentity } from "../providers/types.ts";

const ActorSchema = v.object({
  login: v.string(),
  id: v.number(),
  type: v.string(),
});

const PullRequestSchema = v.object({
  number: v.number(),
  state: v.string(),
  user: ActorSchema,
  head: v.object({
    sha: GitShaSchema,
    ref: v.string(),
    repo: v.nullable(v.object({ full_name: v.string() })),
  }),
  base: v.object({
    sha: GitShaSchema,
    ref: v.string(),
    repo: v.object({ full_name: v.string() }),
  }),
});

const CommitSchema = v.object({
  sha: GitShaSchema,
  commit: v.object({
    message: v.string(),
    committer: v.nullable(v.object({ email: v.nullable(v.string()) })),
  }),
  author: v.nullable(ActorSchema),
  committer: v.nullable(ActorSchema),
  parents: v.array(v.object({ sha: GitShaSchema })),
});

const WorkflowRunSchema = v.object({
  head_sha: GitShaSchema,
  conclusion: v.nullable(v.string()),
  repository: v.object({ full_name: v.string() }),
});

export type GitHubPullRequest = v.InferOutput<typeof PullRequestSchema>;

export class GitHubClient {
  readonly #token: string;

  constructor(token: string) {
    if (!token) throw new Error("GITHUB_TOKEN is required in the resolver job");
    this.#token = token;
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("authorization", `Bearer ${this.#token}`);
    headers.set("user-agent", "depvisor-v2");
    headers.set("x-github-api-version", "2022-11-28");
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1_000);
      throw new Error(`GitHub API ${path} returned ${response.status}: ${body}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async repositoryId(repository: string): Promise<number> {
    const raw = await this.request(`/repos/${repository}`);
    return v.parse(v.object({ id: v.number() }), raw).id;
  }

  async pull(repository: string, number: number): Promise<GitHubPullRequest> {
    return v.parse(PullRequestSchema, await this.request(`/repos/${repository}/pulls/${number}`));
  }

  async pullsForHeadSha(repository: string, sha: string): Promise<GitHubPullRequest[]> {
    const matches: GitHubPullRequest[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const raw = await this.request(
        `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
      );
      const pulls = v.parse(v.array(PullRequestSchema), raw);
      matches.push(...pulls.filter((pull) => pull.head.sha === sha));
      if (pulls.length < 100) break;
    }
    return matches;
  }

  async workflowRun(
    repository: string,
    id: number,
  ): Promise<{ headSha: string; conclusion: string | null }> {
    const run = v.parse(
      WorkflowRunSchema,
      await this.request(`/repos/${repository}/actions/runs/${id}`),
    );
    if (run.repository.full_name.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("workflow_run_id belongs to a different repository");
    }
    return { headSha: run.head_sha, conclusion: run.conclusion };
  }

  async commits(repository: string, number: number): Promise<GitHubCommitIdentity[]> {
    const commits: GitHubCommitIdentity[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const raw = await this.request(
        `/repos/${repository}/pulls/${number}/commits?per_page=100&page=${page}`,
      );
      const parsed = v.parse(v.array(CommitSchema), raw);
      commits.push(
        ...parsed.map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message,
          parents: commit.parents.map((parent) => parent.sha),
          author: commit.author,
          committer: commit.committer,
          committerEmail: commit.commit.committer?.email ?? null,
        })),
      );
      if (parsed.length < 100) break;
    }
    if (commits.length === 300) throw new Error("PR commit chain exceeds the 300-commit bound");
    return commits;
  }

  async fileAtRef(repository: string, path: string, ref: string): Promise<string | null> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `https://api.github.com/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "user-agent": "depvisor-v2",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub contents API returned ${response.status}`);
    const value = v.parse(
      v.object({ encoding: v.string(), content: v.string() }),
      await response.json(),
    );
    if (value.encoding !== "base64") throw new Error("unexpected GitHub contents encoding");
    return Buffer.from(value.content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  async mergeBase(repository: string, base: string, head: string): Promise<string> {
    const raw = await this.request(`/repos/${repository}/compare/${base}...${head}`);
    return v.parse(v.object({ merge_base_commit: v.object({ sha: GitShaSchema }) }), raw)
      .merge_base_commit.sha;
  }

  async applyRefresh(
    repository: string,
    number: number,
    instruction: { kind: "comment" | "label" | "manual"; value: string },
  ): Promise<boolean> {
    if (instruction.kind === "manual") return false;
    if (instruction.kind === "comment") {
      await this.request(`/repos/${repository}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: instruction.value }),
      });
    } else {
      await this.request(`/repos/${repository}/issues/${number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [instruction.value] }),
      });
    }
    return true;
  }

  async upsertComment(
    repository: string,
    number: number,
    marker: string,
    body: string,
  ): Promise<string | null> {
    const comments = v.parse(
      v.array(v.object({ id: v.number(), body: v.nullable(v.string()), html_url: v.string() })),
      await this.request(`/repos/${repository}/issues/${number}/comments?per_page=100`),
    );
    const existing = comments.find((comment) => comment.body?.trimStart().startsWith(marker));
    const raw = existing
      ? await this.request(`/repos/${repository}/issues/comments/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
      : await this.request(`/repos/${repository}/issues/${number}/comments`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });
    return v.parse(v.object({ html_url: v.string() }), raw).html_url;
  }

  async createCheck(
    repository: string,
    headSha: string,
    conclusion: "success" | "failure" | "neutral",
    title: string,
    summary: string,
  ): Promise<void> {
    await this.request(`/repos/${repository}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: "depvisor",
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: { title, summary: summary.slice(0, 65_535) },
      }),
    });
  }
}
