import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PmToolchain } from "./pm.ts";
import type { Candidate, DepKind, UpdateType } from "./types.ts";

// Deliberately unanchored, unlike changelog.ts's end-anchored parseSemver
// (which must keep prerelease tags out of release-note windows): `outdated`
// reports the `latest` dist-tag verbatim, and when a maintainer points it at a
// prerelease (e.g. 2.0.0-rc.1) that exact string is what the update installs,
// so it still classifies from its x.y.z core instead of being dropped.
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

// Pinned to `bun outdated`'s table as of bun 1.3 — any drift must throw, not
// guess. A new column set (e.g. the Workspace column of `-r` mode) lands here.
const BUN_COLUMNS = ["Package", "Current", "Update", "Latest"] as const;

/**
 * Pure half of the bun collector: parse the ASCII table `bun outdated` prints
 * (it has no JSON output and exits 0 whether or not updates exist —
 * oven-sh/bun#15648). Fail-closed: an unknown line, column set, or package
 * annotation throws instead of yielding silently-wrong candidates, so a format
 * change in a future bun version turns the run red. devDependencies carry a
 * ` (dev)` suffix in the Package column; `latest` deliberately comes from the
 * Latest column (registry latest, matching npm/pnpm semantics), not the
 * range-bound Update column.
 */
export function parseBunOutdated(raw: string): Candidate[] {
  const rows: string[][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("bun outdated v")) continue; // blank / version banner
    if (/^\|[-|]+\|$/.test(trimmed)) continue; // table border
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      throw new Error(`unrecognized line in bun outdated output: "${trimmed.slice(0, 120)}"`);
    }
    rows.push(
      trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  const header = rows.shift();
  if (!header) return []; // banner only — everything is current
  if (header.join(",") !== BUN_COLUMNS.join(",")) {
    throw new Error(`unexpected bun outdated columns: "${header.join(" | ")}"`);
  }
  const out: Candidate[] = [];
  for (const row of rows) {
    const [pkgCell = "", current = "", , latest = ""] = row;
    if (row.length !== BUN_COLUMNS.length || !pkgCell) {
      throw new Error(`malformed bun outdated row: "| ${row.join(" | ")} |"`);
    }
    const m = /^(\S+)(?: \((\w+)\))?$/.exec(pkgCell);
    if (!m?.[1]) {
      throw new Error(`malformed package cell in bun outdated output: "${pkgCell}"`);
    }
    if (m[2] !== undefined && m[2] !== "dev") {
      // e.g. a future catalog marker — refuse to guess what it means.
      throw new Error(`unknown package annotation in bun outdated output: "${pkgCell}"`);
    }
    if (!latest || latest === current) continue;
    out.push({
      name: m[1],
      current,
      latest,
      kind: m[2] === "dev" ? "dev" : "prod",
      updateType: classifyUpdate(current, latest),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Collect outdated packages for a repo using the detected package manager's
 * outdated command. This is the deterministic, mechanical half of depvisor —
 * no LLM involved. `pm` must come from the preflight detection (see pm.ts).
 * npm and pnpm read the installed tree (no install → candidates hidden) and
 * exit 1 with JSON still on stdout when updates exist; bun reads the committed
 * lockfile instead (no lockfile → error) and prints a table.
 */
export function collectCandidates(repoPath: string, pm: PmToolchain): Candidate[] {
  const [cmd, ...args] = pm.outdatedArgv;
  // FORCE_COLOR switches bun to box-drawing + ANSI output even without a TTY,
  // and it beats NO_COLOR (verified against bun 1.3.14) — strip it so the
  // table parser only ever sees the plain `|`-bordered form.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const res = spawnSync(cmd, args, { cwd: repoPath, encoding: "utf8", env });
  if (res.error) throw new Error(`${pm.name} outdated failed to run: ${res.error.message}`);

  // bun exits 0 whether or not updates exist (oven-sh/bun#15648), so — unlike
  // npm/pnpm, whose normal "updates exist" path is exit 1 — a non-zero bun exit
  // is unambiguously an error (e.g. a missing/broken lockfile, whose stdout is
  // just the version banner and would otherwise parse to an empty, silently
  // wrong "no updates"). Fail closed before the banner ever reaches the parser.
  if (pm.name === "bun" && res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    throw new Error(
      `bun outdated failed (exit ${res.status})` + (stderr ? `: ${stderr.slice(0, 200)}` : ""),
    );
  }

  const raw = (res.stdout || "").trim();
  if (!raw) return [];

  if (pm.name === "bun") {
    try {
      return parseBunOutdated(raw);
    } catch (err) {
      const stderr = (res.stderr ?? "").trim();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `bun outdated output was not parseable (exit ${res.status}): ${message}` +
          (stderr ? ` — stderr: ${stderr.slice(0, 200)}` : ""),
      );
    }
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const stderr = (res.stderr ?? "").trim();
    throw new Error(
      `${pm.name} outdated produced non-JSON output (exit ${res.status}): ${raw.slice(0, 200)}` +
        (stderr ? ` — stderr: ${stderr.slice(0, 200)}` : ""),
    );
  }
  if (pm.name === "pnpm") return parsePnpmOutdated(data);

  const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
  const devSet = new Set(Object.keys(pkg.devDependencies ?? {}));
  return parseOutdated(data, devSet);
}
