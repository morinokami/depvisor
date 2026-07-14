# deterministic v2 core

`types.ts` and `artifacts.ts` single-source the normalized public/job contracts.
Artifacts are size-bounded and schema-validated at every consumer.

`config.ts` parses only base-tip `.github/depvisor.yml`. Missing, malformed,
unknown-version, and unknown-key configs fail closed. An enabled repair without
commands becomes `verification-unavailable`; review-only mode needs no commands.

`git.ts` uses hook-disabled git leaves. `ref-guard.ts` snapshots/restores all
refs around target execution. Verification additionally seals the candidate
worktree by content/mode fingerprints.

`scope.ts` is the final source/test gate. Ecosystem adapters contribute exact
protected paths; the core also denies known dependency basenames, CI/hooks,
package-manager config, and execution surfaces. Add every new dependency or
execution config surface here and to the fixer instructions.

`result.ts` is the terminal decision table: only green baseline + stable-red head

- scope-valid fixer candidate + green isolated candidate sets `pushCandidate`.

`report.ts` renders bounded deterministic facts and sanitized reviewer fields.
The model never decides whether a repair is called applied.
