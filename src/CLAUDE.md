# src/ — outside the deterministic core

`core/` has its own CLAUDE.md. This file covers the entrypoints and the agent boundary. Each module's rationale lives in its file header.

## The plain-node / Flue-bundler split

`agents/depvisor.ts` imports its instructions with `with { type: "markdown" }`, a Flue-bundler-only feature, so that discovered entrypoint loads **only** under `flue run` / `flue build` — never under plain `node` (`ERR_UNKNOWN_FILE_EXTENSION`).

Flue discovers each immediate `agents/*.ts` / `workflows/*.ts` file as an entrypoint; nested files are ordinary support modules. Keep helpers that tests or other plain-node paths import nested (`agents/shared/tasks.ts`, `workflows/aftercare/process-pr.ts`), and never import the discovered `agents/depvisor.ts` or `workflows/aftercare.ts` entrypoints from a plain-node path.

## The agent boundary — capability, not instruction

`agents/depvisor.ts` is a `defineAgent` root that is **never prompted**. It exists only to select Flue's in-memory virtual sandbox (`cwd: /workspace`, so built-in fs/shell cannot see the runner) and to hold the two `defineAgentProfile`s the workflow delegates to via `session.task(prompt, { agent, result })`.

`agents/shared/tasks.ts` owns the two task prompts and their Valibot result schemas. `workflows/aftercare/process-pr.ts` owns one PR's deterministic gate sequence (head verification → baseline attribution → fixer → post-repair gates → digest → sealed payload) and the two task calls; its explicit outcome returns the status, payload, repair provenance, and usage to the entrypoint. Neither nested module is a separately discovered Flue surface.

- **fixer** (`agents/fixer.md`) — repo-jailed read tools, `write_repo_file` / `replace_repo_text` / `remove_repo_file`, and the bounded `fetch_release_notes` (`tools/release-notes.ts`), which is the single narrow door for untrusted external text. Never raw agent HTTP. It runs **only** on the attributed failure path (head red, merge base green), has **no host shell**, and cannot run verification itself — the workflow owns the sole authoritative post-repair run.
- **digest** — `list_repo_files` / `read_repo_file` / `search_repo` only, no write or exec capability. Runs for every analyzed PR, strictly after any repair commit is sealed. Release notes are fetched deterministically and injected into its prompt.

`tools/repo-files.ts` is the **only** host bridge: every path must be repo-relative, must resolve below the real target root even through symlinks, `.git` is rejected, and reads/writes/listings are bounded. Keep digest's profile on `repoReadTools`.

This is enforcement, not a prompt-only "stay read-only" promise. Do not reintroduce `local()` or a host shell tool without restoring an OS-level isolation boundary first.

Tool modules are not auto-discovered — `depvisor.ts` attaches them explicitly. For Flue API questions use the `flue` skill rather than guessing; the dependency is an exact-pinned beta.

## Entrypoints

| File                                            | Runs as                                               | Token it holds |
| ----------------------------------------------- | ----------------------------------------------------- | -------------- |
| `check-credentials.ts`                          | first target-touching Action step, before the install | none           |
| `check-config.ts`                               | config validation before the target install           | none           |
| `install-target.ts`                             | the `install_command: auto` step                      | none           |
| `workflows/aftercare.ts` (`flue run aftercare`) | the analyze/repair/report step                        | LLM key only   |
| `publish.ts`                                    | repair push + report comment upsert                   | `GH_TOKEN`     |
| `report-status.ts`                              | annotations, step summary, action outputs             | none           |
| `dev/scan.ts`                                   | dev tool + CI `fixture-e2e` gate, **not** the action  | none           |

`publish.ts` is the only command that needs `GH_TOKEN`. It takes the PR identity from trusted env (`DEPVISOR_PR_NUMBER`/`DEPVISOR_HEAD_REF`, set by action.yml from the event context), treats the payload file as an untrusted read-back that must merely agree, and delegates every push-boundary check to `core/github.ts:publishAftercare`. A missing payload is a benign no-op; a blocked publish (moved head, closed PR) stays green.

`report-status.ts` writes `$GITHUB_OUTPUT` on both the normal and the missing/corrupt-status-file path, **before** any `exit(1)`, which is what makes the composite action's outputs usable from `if: always()` consumer steps.

`shared/target.ts` holds `REPO`, the target checkout (CI checkout, or the throwaway fixture locally). It is deliberately **not** the virtual agent sandbox cwd.
