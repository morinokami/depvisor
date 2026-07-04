import { detectPersistedCredentials, persistedCredentialsSummary } from "./core/credentials.ts";
import { REPO } from "./shared/target.ts";

/**
 * Composite action entrypoint: refuse to run when the target checkout carries
 * persisted git credentials (actions/checkout defaults to persist-credentials:
 * true). Runs before the target's dependencies are installed — their lifecycle
 * scripts, like the agent step, must never see a token. This is a plain-node
 * entrypoint and must not import agent/workflow modules.
 */

function main(): void {
  const findings = detectPersistedCredentials(REPO);
  if (findings.length > 0) {
    console.error(`::error::${persistedCredentialsSummary(findings)}`);
    process.exit(1);
  }
  console.log("depvisor check-credentials → no persisted credentials in the target checkout.");
}

main();
