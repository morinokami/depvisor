import { fileURLToPath } from "node:url";

// Shared target checkout for the workflow and the updater agent (`cwd`):
// GitHub Actions sets DEPVISOR_TARGET_REPO; local runs default to the fixture.
// `||`, never `??`: an empty string means "not set" (composite actions forward
// unset inputs as ""), matching every other DEPVISOR_* env read.
export const REPO =
  process.env.DEPVISOR_TARGET_REPO ||
  fileURLToPath(new URL("../../fixtures/sample-app", import.meta.url));
