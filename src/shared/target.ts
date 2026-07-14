// The Flue sandbox is in-memory. These repo-jailed tools are its only host bridge.
export const REPO = process.env.DEPVISOR_TARGET_REPO || process.cwd();
