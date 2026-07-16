/** Target updater-PR checkout. GitHub Actions sets the explicit path. */
export const REPO = process.env.DEPVISOR_TARGET_REPO || process.cwd();
