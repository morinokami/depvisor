/**
 * The token-holding Action step writes an open-PR snapshot; this module is the
 * token-free boundary that validates and normalizes it. Mergeability is a
 * fail-soft observation used only to decide whether an existing PR should be
 * regenerated. A missing, malformed, or future enum value never fails a run or
 * causes speculative refreshes.
 *
 * Precedence is deliberate: an explicit conflict wins over every other field;
 * a known non-conflicting value wins over UNKNOWN from the redundant field;
 * explicit UNKNOWN is retained for an honest skip summary; absent/invalid
 * fields preserve the legacy summary.
 */

import { readFileSync } from "node:fs";

const MERGEABLE = new Set(["CONFLICTING", "MERGEABLE", "UNKNOWN"]);
const MERGE_STATE_STATUS = new Set([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);

export interface OpenPrMetadata {
  number: number | null;
  headRefName: string;
  body: string;
  conflicted: boolean;
  mergeabilityUnknown: boolean;
  mergeabilityObserved: boolean;
}

export interface SnapshotPrFields {
  number?: number;
  headRefName?: string;
  body?: string;
  mergeable?: string;
  mergeStateStatus?: string;
}

function knownString(value: unknown, values: ReadonlySet<string>): string | null {
  return typeof value === "string" && values.has(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeabilityOf(
  entry: SnapshotPrFields,
): Pick<OpenPrMetadata, "conflicted" | "mergeabilityUnknown" | "mergeabilityObserved"> {
  const mergeable = knownString(entry.mergeable, MERGEABLE);
  const mergeState = knownString(entry.mergeStateStatus, MERGE_STATE_STATUS);
  const conflicted = mergeable === "CONFLICTING" || mergeState === "DIRTY";
  if (conflicted) {
    return { conflicted: true, mergeabilityUnknown: false, mergeabilityObserved: true };
  }

  const knownNonConflict =
    mergeable === "MERGEABLE" || (mergeState !== null && mergeState !== "UNKNOWN");
  if (knownNonConflict) {
    return { conflicted: false, mergeabilityUnknown: false, mergeabilityObserved: true };
  }

  const unknown = mergeable === "UNKNOWN" || mergeState === "UNKNOWN";
  return {
    conflicted: false,
    mergeabilityUnknown: unknown,
    mergeabilityObserved: unknown,
  };
}

export function parseOpenPrSnapshot(value: unknown): OpenPrMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const fields = entry;
    if (typeof fields.headRefName !== "string" || !fields.headRefName) return [];
    const normalized = mergeabilityOf({
      ...(typeof fields.mergeable === "string" ? { mergeable: fields.mergeable } : {}),
      ...(typeof fields.mergeStateStatus === "string"
        ? { mergeStateStatus: fields.mergeStateStatus }
        : {}),
    });
    return [
      {
        number:
          typeof fields.number === "number" &&
          Number.isSafeInteger(fields.number) &&
          fields.number > 0
            ? fields.number
            : null,
        headRefName: fields.headRefName,
        body: typeof fields.body === "string" ? fields.body : "",
        ...normalized,
      },
    ];
  });
}

/**
 * Read the optional snapshot. CI owns its availability by failing the snapshot
 * step when the initial list fails. Local/mixed-version runs fail open here:
 * skip-if-up-to-date may do extra work and the PR ceiling may be exceeded. The
 * same undercount can happen above the Action's explicit 1,000-PR list cap.
 * A corrupt file never suppresses an update or invents a conflict.
 */
export function readOpenPrSnapshot(file: string | undefined): OpenPrMetadata[] {
  if (!file) return [];
  try {
    return parseOpenPrSnapshot(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return [];
  }
}

/** REST pull detail's nullable boolean normalized to the GraphQL vocabulary. */
export function normalizeRestMergeable(value: unknown): "CONFLICTING" | "MERGEABLE" | "UNKNOWN" {
  if (value === false) return "CONFLICTING";
  if (value === true) return "MERGEABLE";
  return "UNKNOWN";
}
