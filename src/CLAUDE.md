# src entrypoints and capability boundary

`agents/depvisor.ts` imports Markdown instructions and uses `local()` from
`@flue/runtime/node`; it is Flue-bundler-only. Nested core/shared modules remain
plain-Node-safe and use explicit `.ts` imports. `shared/` carries the entrypoint
plumbing (`env`, `github-api`, `actions`, `target`); entrypoints must not grow
private copies of these helpers — the token boundary lives in which step runs
them, not in duplicated code.

| Entrypoint             | Role                                                      | Credentials                                    |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| `check-credentials.ts` | Reject repo-local persisted git credentials               | none                                           |
| `prepare.ts`           | Resolve PR, changed files, failed jobs/logs, frozen state | `GH_TOKEN`                                     |
| `workflows/repair.ts`  | Autonomous repository repair/review                       | model provider key in runtime; no GitHub token |
| `publish.ts`           | Fresh-clone commit/push and maintained PR comment         | `GH_TOKEN`                                     |
| `report-status.ts`     | Action outputs and step summary                           | none                                           |

The root agent is prompted directly once through `session.prompt` with a Valibot
result schema. It has the target checkout as `cwd` and Flue's local sandbox, so
ordinary file/shell operations are the primary capability. No fixer/digest
subagents or custom repository tools remain.

The provider key is needed by Flue itself but is not passed through `local()`'s
default shell env allowlist. The GitHub token is absent from the entire agent
step. This reduces accidental credential exposure but is not host isolation:
model-directed code runs as the runner user. A background process can survive
into the later step, and runner-writable executables, PATH entries, and run-temp
status files are not attested. Malicious target install scripts share that
authority; keep this residual risk explicit until publisher/reporter run on a
fresh isolated runner.
