/** Shared prompt-context budgets for untrusted GitHub text. */

export const MAX_PATCH_CHARS = 16_000;
export const MAX_TOTAL_PATCH_CHARS = 180_000;

export interface CharacterBudget {
  remaining: number;
}

/** Take a bounded prefix while consuming one run-wide character budget. */
export function takeText(value: string, perItemLimit: number, budget: CharacterBudget): string {
  const length = Math.min(value.length, perItemLimit, Math.max(0, budget.remaining));
  const result = value.slice(0, length);
  budget.remaining -= result.length;
  return result;
}
