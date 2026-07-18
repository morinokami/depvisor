/** Shared fail-closed JSON shape guard for validated handoffs. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Read an optional string field of untrusted JSON; any other type reads as "". */
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Read an optional integer field of untrusted JSON; any other value reads as 0. */
export function int(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}
