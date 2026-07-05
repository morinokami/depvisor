/**
 * The run-status filename, in its own leaf module so both `pr.ts` (which clears
 * prior output) and `status.ts` (which reads/writes it) can reference it without
 * an import cycle — `status.ts` imports `sanitizeSummary` from `pr.ts`.
 */
export const RUN_STATUS_FILE = "status.json";
