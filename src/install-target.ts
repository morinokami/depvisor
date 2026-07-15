import { runInstall } from "./core/install.ts";
import { detectPackageManager } from "./core/pm.ts";
import { REPO } from "./shared/target.ts";

/**
 * Composite action entrypoint for `install_command: auto`. Detects the target
 * repo's package manager and runs the matching lockfile-faithful install so
 * the head verification runs against the PR's own dependency state.
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
    // The baseline/head attribution reinstalls need a lockfile-faithful
    // install too, so a lockfile-less repo cannot be aftercared under "auto";
    // say so plainly instead of guessing an install that would dirty the tree.
    console.error(
      `::error::install_command "auto" needs a committed ${detected.pm.name} lockfile ` +
        `(${detected.pm.lockfiles.join(" or ")}) and found none in ${REPO}. Commit a ` +
        `lockfile, or set the install_command input to your own install command.`,
    );
    process.exit(1);
  }
  console.log(
    `depvisor install-target → ${detected.pm.name} detected via ${detected.source}; running: ${command}`,
  );
  const res = runInstall(REPO, command);
  if (res.error) {
    console.error(`::error::${command} failed to run: ${res.error}`);
    process.exit(1);
  }
  process.exit(res.code);
}

main();
