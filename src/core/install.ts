import { spawnSync } from "node:child_process";

// Same rationale as verify.ts's STEP_TIMEOUT_MS: a hung install (stalled
// network, interactive prompt) must not eat the whole CI job. Installs get a
// larger budget than verify steps because cold registry fetches are slow.
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Run a dependency install command in `repo`. Shared by `install-target.ts`
 * (the pre-agent install behind `install_command: auto`) and the aftercare
 * flow's baseline/head attribution reinstalls, which all need a
 * lockfile-faithful install.
 *
 * `shell: true` because the command is a full shell string: either a fixed
 * `PmToolchain.installCommand` (e.g. `npm ci`) or the trusted, workflow-supplied
 * `install_command` input — never anything from the agent-writable target tree.
 * stdio is inherited so install output lands in the step log.
 *
 * Returns `ok` plus the process exit code, and `error` (a spawn-level message)
 * only when the command could not be launched at all — including a timeout,
 * which surfaces as an ETIMEDOUT spawn error.
 */
export function runInstall(
  repo: string,
  command: string,
): { ok: boolean; code: number; error?: string } {
  const res = spawnSync(command, {
    cwd: repo,
    shell: true,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (res.error) return { ok: false, code: 1, error: res.error.message };
  const code = res.status ?? 1;
  return { ok: code === 0, code };
}
