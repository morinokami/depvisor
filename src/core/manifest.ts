/**
 * Shared package.json vocabulary for the modules that plan or gate manifest
 * edits (pm.ts's update planning and scope.ts's bump-scope gate). Single-
 * sourced so the sections the planner classifies and the sections the gate
 * allow-lists cannot drift apart. A tiny leaf, in the style of version-core.ts.
 */

/** The package.json sections a dependency can be declared in — equivalently,
 * the only sections a dependency bump legitimately edits. */
export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** A parsed (JSON/YAML) value that is a plain string→value map, else null. */
export function asPlainMap(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
