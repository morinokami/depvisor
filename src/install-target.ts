import { spawnSync } from "node:child_process";
import { detectPackageManager } from "./core/pm.ts";
import { REPO } from "./shared/target.ts";

/**
 * Composite action entrypoint for `install_command: auto`. Detects the target
 * repo's package manager and runs the matching install so the outdated check
 * can read the installed tree.
 *
 * Runs before the agent on the trusted checkout. Unsupported or ambiguous PMs
 * fail here with a clear ::error instead of producing a partial update. This is
 * a plain-node entrypoint and must not import agent/workflow modules.
 */

function main(): void {
  const detected = detectPackageManager(REPO);
  if (!detected.ok) {
    console.error(`::error::${detected.summary}`);
    process.exit(1);
  }
  const command = detected.pm.installCommand(REPO);
  if (command === null) {
    console.error(
      `::error::install_command "auto" needs a committed ${detected.pm.name} lockfile ` +
        `(${detected.pm.lockfiles.join(" or ")}) and found none in ${REPO}. Commit a ` +
        `lockfile, or — if your repository tracks none by policy — set the ` +
        `install_command input to "${detected.pm.noLockfileInstall}" (a bare install ` +
        `would create the lockfile, and depvisor refuses the resulting dirty tree).`,
    );
    process.exit(1);
  }
  console.log(
    `depvisor install-target → ${detected.pm.name} detected via ${detected.source}; running: ${command}`,
  );
  const res = spawnSync(command, { cwd: REPO, shell: true, stdio: "inherit" });
  if (res.error) {
    console.error(`::error::${command} failed to run: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

main();
