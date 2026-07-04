// Shared target checkout for the workflow and the updater agent (`cwd`):
// GitHub Actions sets DEPVISOR_TARGET_REPO; local runs default to the fixture.
export const REPO =
  process.env.DEPVISOR_TARGET_REPO ??
  new URL("../../fixtures/sample-app", import.meta.url).pathname;
