# src entrypoints and capability boundary

`agents/depvisor.ts` imports Markdown instructions and uses `local()` from
`@flue/runtime/node`; only Flue's bundler can build it. Nested core/shared
modules remain safe to run under plain Node and use explicit `.ts` imports.
`shared/` carries the entrypoint plumbing (`env`, `github-api`, `actions`,
`target`); `tools/` holds one file per agent tool. Entrypoints must not grow
private copies of these helpers — the token boundary lives in which step runs
them, not in duplicated code.

| Entrypoint                | Role                                                                                   | Credentials                                    |
| ------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `check-credentials.ts`    | Reject repo-local persisted git credentials                                            | none                                           |
| `prepare.ts`              | Resolve PR, skip already-reviewed heads, changed files, failed jobs/logs, frozen state | `GH_TOKEN`                                     |
| `workflows/fix.ts`        | Autonomous repository review and fix                                                   | model provider key in runtime; no GitHub token |
| `publish.ts`              | Fresh-clone commit/push and maintained PR comment                                      | `GH_TOKEN`                                     |
| `report-status.ts`        | Action outputs and step summary                                                        | none                                           |
| `self-check-collect.ts`   | Bounded envelope of recent depvisor runs plus self-check issue titles                  | `GH_TOKEN`                                     |
| `workflows/self-check.ts` | Findings analysis over the collected envelope                                          | model provider key in runtime; no GitHub token |
| `self-check-report.ts`    | Re-validate findings and file labeled issues with reporter-built links                 | `GH_TOKEN`                                     |

The root agent is prompted directly once through `session.prompt` with a Valibot
result schema. It has the target checkout as `cwd` and Flue's local sandbox, so
ordinary file/shell operations are the primary capability. Two read-only
upstream-evidence tools (`fetch_release_notes` and `diff_npm_package`, one
file each under `tools/`, logic in `core/upstream.ts`) run in the Flue
process with no credential, contact only api.github.com,
raw.githubusercontent.com, and registry.npmjs.org with lexically validated
coordinates, and return size-capped untrusted text. No fixer/digest subagents remain.

The weekly self-check (`.github/workflows/self-check.yml`) reuses this
privilege separation with fewer capabilities. `agents/self-check.ts`
deliberately has no `local()` sandbox, tools, or checkout access: the analyst
only reads the collector envelope embedded in its prompt (untrusted log
excerpts, bounded by `self-check-collect.ts`) and returns findings validated
against `core/self-check.ts`. The reporter re-validates that handoff, resolves
every cited run id against the envelope, builds all evidence links itself, and
files at most two `self-check`-labeled issues, never filing a title that is
already open or was already filed earlier in the same run.

The provider key is needed by Flue itself but is not passed through `local()`'s
default shell env allowlist. The GitHub token is absent from the entire agent
step. This reduces accidental credential exposure but is not host isolation:
the agent's shell commands run as the runner user. A background process can
survive into the later step, and runner-writable executables, PATH entries, and
status files under `runner.temp` are not attested. Malicious target install
scripts share that access; keep this residual risk explicit until
publisher/reporter run on a fresh isolated runner.
