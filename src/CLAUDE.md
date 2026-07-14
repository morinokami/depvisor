# v2 source boundary

Plain Node loads every TypeScript module except `agents/depvisor.ts`, whose
Markdown imports are bundled by Flue.

The LLM may only:

- inspect the target through bounded read/list/search tools;
- on the stable-failure path, propose one source/test edit through bounded write
  tools; and
- return typed fixer/reviewer data.

It may not run target commands, git, GitHub APIs, or package managers. Resolver,
normalization, verification, patch serialization, scope, publication, and result
classification stay deterministic. The GitHub workflow keeps each credential or
target-execution capability in its own job.

Entrypoints:

- `cli/resolve.ts`: read-token resolver/provider attestation/base-SHA config.
- `cli/normalize.ts`: immutable three-dot dependency normalization and policy.
- `cli/verify.ts`: baseline/head confirmation and candidate verification.
- `workflows/aftercare.ts`: reviewer or one-shot fixer task, no GitHub token.
- `cli/candidate.ts`: serialize/scope/hash the fixer working tree.
- `cli/publish.ts`: write-token compare-and-swap publisher, no target execution.
