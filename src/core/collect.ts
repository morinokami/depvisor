import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PmToolchain } from "./pm.ts";
import type { Candidate, DepKind, UpdateType } from "./types.ts";

function parseVersion(v: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Classify an update as patch/minor/major from the current vs latest version.
 * Returns 'unknown' when either side is unparseable (e.g. MISSING) or when
 * `latest` is not ahead of `current` (e.g. a prerelease newer than the latest
 * dist-tag is installed) — "update to latest" would be a downgrade there, so
 * grouping excludes 'unknown' candidates from agent work.
 */
export function classifyUpdate(current: string, latest: string): UpdateType {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return "unknown";
  if (l[0] > c[0]) return "major";
  if (l[0] === c[0] && l[1] > c[1]) return "minor";
  if (l[0] === c[0] && l[1] === c[1] && l[2] > c[2]) return "patch";
  return "unknown";
}

/** Pure half of the collector: turn `npm outdated --json` output into candidates. */
export function parseOutdated(data: Record<string, unknown>, devDeps: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const [name, infoRaw] of Object.entries(data)) {
    const info = (Array.isArray(infoRaw) ? infoRaw[0] : infoRaw) as Record<string, string>;
    const current = String(info.current ?? "");
    const latest = String(info.latest ?? "");
    if (!latest || latest === current) continue;
    const kind: DepKind = devDeps.has(name) ? "dev" : "prod";
    out.push({ name, current, latest, kind, updateType: classifyUpdate(current, latest) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Pure half of the pnpm collector: turn `pnpm outdated --format json` output
 * into candidates. Unlike npm's, pnpm's entries carry `dependencyType`, so no
 * devDependencies set is needed.
 */
export function parsePnpmOutdated(data: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = [];
  for (const [name, infoRaw] of Object.entries(data)) {
    const info = infoRaw as Record<string, string>;
    const current = String(info.current ?? "");
    const latest = String(info.latest ?? "");
    if (!latest || latest === current) continue;
    const kind: DepKind = info.dependencyType === "devDependencies" ? "dev" : "prod";
    out.push({ name, current, latest, kind, updateType: classifyUpdate(current, latest) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Collect outdated packages for a repo using the detected package manager's
 * outdated command. This is the deterministic, mechanical half of depvisor —
 * no LLM involved. `pm` must come from the preflight detection (see pm.ts):
 * both commands read the installed tree, and both exit 1 with JSON still on
 * stdout when updates exist.
 */
export function collectCandidates(repoPath: string, pm: PmToolchain): Candidate[] {
  const [cmd, ...args] = pm.outdatedArgv;
  const res = spawnSync(cmd, args, { cwd: repoPath, encoding: "utf8" });
  if (res.error) throw new Error(`${pm.name} outdated failed to run: ${res.error.message}`);
  const raw = (res.stdout || "").trim();
  if (!raw) return [];

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${pm.name} outdated produced non-JSON output (exit ${res.status}): ${raw.slice(0, 200)}${(res.stderr ?? "").slice(0, 200)}`,
    );
  }
  if (pm.name === "pnpm") return parsePnpmOutdated(data);

  const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
  const devSet = new Set(Object.keys(pkg.devDependencies ?? {}));
  return parseOutdated(data, devSet);
}
