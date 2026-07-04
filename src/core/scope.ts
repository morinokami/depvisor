import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedPaths, fileAtRef } from "./git.ts";

/**
 * Diff-scope gate. The agent is instructed not to touch unrelated files, but a
 * poisoned changelog can override instructions; this deny-list is enforced
 * deterministically before anything is committed.
 */
const DENY: RegExp[] = [
  /^\.github\//, // workflows, actions config
  /^\.husky\//, // git hooks run on developer machines
  /^\.circleci\//,
  /^\.gitlab-ci\.yml$/,
  /(^|\/)\.npmrc$/, // registry redirection → arbitrary code on next install
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)\.pnpmfile\.cjs$/, // pnpm install hooks → arbitrary code on next install
  /^pnpm-workspace\.yaml$/, // pnpm settings, incl. which deps may run build scripts
  /^\.yarn\//, // yarn plugins/releases are executable JS
  /(^|\/)bunfig\.toml$/,
];

export function scopeViolations(paths: string[]): string[] {
  return paths.filter((p) => DENY.some((re) => re.test(p)));
}

function isPackageJson(p: string): boolean {
  return p === "package.json" || p.endsWith("/package.json");
}

/**
 * package.json fields a dependency bump should not edit. Each controls code
 * execution or dependency sources: `scripts`, `packageManager`, `pnpm`, and
 * `overrides`/`resolutions`. Updates that need these changes must be deferred
 * to a human.
 */
const GUARDED_FIELDS = ["scripts", "packageManager", "pnpm", "overrides", "resolutions"] as const;

/** A named field of a package.json source; undefined when absent/unparseable. */
function fieldOf(source: string | null, field: string): unknown {
  if (source === null) return undefined;
  try {
    const pkg = JSON.parse(source) as Record<string, unknown>;
    return pkg && typeof pkg === "object" ? pkg[field] : undefined;
  } catch {
    return undefined;
  }
}

/** Key-order-insensitive stringification, so equal objects compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The guarded fields that differ between two package.json contents (either
 * side may be null = file absent). Any difference is out of scope — see
 * `checkDiffScope`. Unequal on any doubt (added/removed key, changed value,
 * one side unparseable while the other has the field).
 */
export function packageJsonGuardedFieldChanges(
  before: string | null,
  after: string | null,
): string[] {
  return GUARDED_FIELDS.filter(
    (field) => canonical(fieldOf(before, field)) !== canonical(fieldOf(after, field)),
  );
}

/**
 * Deny-list violations plus package.json guarded-field tampering. package.json
 * must allow version bumps, so each changed package.json is diffed against
 * `base`; any change to a guarded field is a scope violation because it can
 * affect lifecycle execution or dependency resolution in the target project.
 */
export function checkDiffScope(repo: string, base: string): { ok: boolean; violations: string[] } {
  const paths = changedPaths(repo);
  const violations = scopeViolations(paths);
  for (const p of paths) {
    if (!isPackageJson(p)) continue;
    let after: string | null;
    try {
      after = readFileSync(join(repo, p), "utf8");
    } catch {
      after = null; // deleted in the working tree
    }
    for (const field of packageJsonGuardedFieldChanges(fileAtRef(repo, base, p), after)) {
      violations.push(`${p} (${field})`);
    }
  }
  return { ok: violations.length === 0, violations };
}
