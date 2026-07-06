import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
 * The lowest of several `current` versions — used when one dependency is
 * declared at different versions across workspaces (npm reports these as an
 * array). Picking the lowest makes the jump to `latest` the largest, so the
 * classification (patch/minor/major) is the most conservative one. Unparseable
 * versions are ignored unless all are, in which case the first is kept so the
 * candidate still surfaces (as 'unknown', excluded from grouping downstream).
 */
function lowestVersion(versions: string[]): string {
  let lowest: string | undefined;
  let lowestParsed: [number, number, number] | undefined;
  for (const v of versions) {
    const p = parseVersion(v);
    if (!p) continue;
    if (!lowestParsed || compareVersion(p, lowestParsed) < 0) {
      lowest = v;
      lowestParsed = p;
    }
  }
  return lowest ?? versions[0] ?? "";
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** An absolute workspace path relativized against the repo root; root → "". */
function relativeLocation(repoPath: string, location: string | undefined): string {
  if (!location) return "";
  return relative(repoPath, location);
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

/**
 * Pure half of the collector: turn `npm outdated --json --long` output into
 * candidates. `--long` adds the two fields workspaces need: `type`
 * (dependencies/devDependencies, so dev/prod is judged per-occurrence rather
 * than from the root package.json) and `dependedByLocation` (the repo-relative
 * workspace path, "" for the root). A dependency declared at different versions
 * across workspaces arrives as an array; all occurrences are merged into one
 * candidate — `current` is the lowest (most conservative classification),
 * `locations` is the union, and `kind` is dev only when every occurrence is a
 * devDependency (a mix falls to prod, i.e. no `-D`).
 */
export function parseOutdated(data: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = [];
  for (const [name, infoRaw] of Object.entries(data)) {
    const entries = (Array.isArray(infoRaw) ? infoRaw : [infoRaw]) as Record<string, string>[];
    const currents: string[] = [];
    const locations = new Set<string>();
    let latest = "";
    let allDev = entries.length > 0;
    for (const info of entries) {
      const cur = String(info.current ?? "");
      if (cur) currents.push(cur);
      const lat = String(info.latest ?? "");
      if (lat) latest = lat; // registry `latest`, identical across occurrences
      locations.add(String(info.dependedByLocation ?? ""));
      if (info.type !== "devDependencies") allDev = false;
    }
    const current = lowestVersion(currents);
    if (!latest || latest === current) continue;
    const kind: DepKind = allDev ? "dev" : "prod";
    out.push({
      name,
      current,
      latest,
      kind,
      updateType: classifyUpdate(current, latest),
      locations: [...locations].sort(),
      currents: [...new Set(currents)].sort(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Pure half of the pnpm collector: turn `pnpm outdated -r --format json` output
 * into candidates. `-r` is what makes workspace dependencies visible at all
 * (without it only the root package's deps are reported). Unlike npm's, pnpm's
 * entries carry `dependencyType`, so no devDependencies set is needed;
 * `dependentPackages[].location` (an absolute path) is relativized against
 * `repoPath`. pnpm keys its JSON by package name, so a dependency declared at
 * different versions across workspaces collapses to a single occurrence here —
 * `locations` may therefore be incomplete, but `pnpm -r update` still reaches
 * every declaring workspace, so nothing is left stale.
 */
export function parsePnpmOutdated(data: Record<string, unknown>, repoPath: string): Candidate[] {
  const out: Candidate[] = [];
  for (const [name, infoRaw] of Object.entries(data)) {
    const info = infoRaw as {
      current?: string;
      latest?: string;
      dependencyType?: string;
      dependentPackages?: { location?: string }[];
    };
    const current = String(info.current ?? "");
    const latest = String(info.latest ?? "");
    if (!latest || latest === current) continue;
    const locations = new Set<string>();
    for (const dep of info.dependentPackages ?? []) {
      locations.add(relativeLocation(repoPath, dep.location));
    }
    if (locations.size === 0) locations.add(""); // defensive: treat as root
    const kind: DepKind = info.dependencyType === "devDependencies" ? "dev" : "prod";
    out.push({
      name,
      current,
      latest,
      kind,
      updateType: classifyUpdate(current, latest),
      locations: [...locations].sort(),
      // pnpm's name-keyed JSON reports one entry per package whose `current` is
      // the HIGHEST installed version across workspaces; lower-versioned
      // workspaces are omitted entirely (verified on pnpm 11). So `currents` can
      // only carry that highest version — advisory matching therefore misses an
      // advisory that affects solely an omitted lower version (fail-soft: the
      // `pnpm -r update` still fixes every workspace; only the promotion/
      // Security-column hint is lost). npm/bun report every occurrence, so their
      // `currents` is complete. Reconstructing pnpm's per-workspace versions
      // would need a second command (`pnpm list -r`); deliberately not done.
      currents: current ? [current] : [],
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Pinned to `bun outdated -r`'s table as of bun 1.3 — any drift must throw, not
// guess. depvisor always passes `-r` (see pm.ts), so the Workspace column is
// always present, for single-package repos too (Workspace = the repo's name).
const BUN_COLUMNS = ["Package", "Current", "Update", "Latest", "Workspace"] as const;

/**
 * Map each bun workspace's package name to its repo-relative path, by expanding
 * the root package.json `workspaces` globs. `bun outdated -r` reports the
 * declaring workspace by name, but `bun add` scopes by path (`--cwd`), so this
 * bridges the two. The root is keyed both by its `name` (when it has one) and by
 * "" — `bun outdated -r` leaves the Workspace cell empty for a root dependency
 * when the (typically private) root package omits `name`. Supported patterns: a
 * literal directory or a single-level `dir/*`; any other glob (`**`, braces,
 * negation) throws, and so does a workspace name that later has no path here —
 * fail-closed, because guessing would scope an update to the wrong manifest.
 */
export function bunWorkspaceMap(repoPath: string): Map<string, string> {
  const nameAt = (dir: string): string | null => {
    try {
      const pkg = JSON.parse(readFileSync(join(repoPath, dir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      return typeof pkg.name === "string" ? pkg.name : null;
    } catch {
      return null;
    }
  };

  const map = new Map<string, string>();
  // The root workspace: `bun outdated -r` labels a root dependency with the root
  // package's name when it has one, but with an EMPTY Workspace cell when the
  // (typically private) root omits `name`. Map both spellings to the root path.
  map.set("", "");
  const rootName = nameAt(".");
  if (rootName) map.set(rootName, "");

  const rootPkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
    workspaces?: unknown;
  };
  // bun accepts both the array form and npm's `{ packages: [...] }` object form.
  const ws = rootPkg.workspaces;
  const patterns = Array.isArray(ws)
    ? ws
    : Array.isArray((ws as { packages?: unknown })?.packages)
      ? (ws as { packages: unknown[] }).packages
      : [];

  for (const patternRaw of patterns) {
    if (typeof patternRaw !== "string") continue;
    const pattern = patternRaw.replace(/\/+$/, "");
    let dirs: string[];
    if (!pattern.includes("*")) {
      dirs = [pattern];
    } else if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const parent = pattern.slice(0, -2);
      try {
        dirs = readdirSync(join(repoPath, parent), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => `${parent}/${e.name}`);
      } catch {
        dirs = [];
      }
    } else {
      throw new Error(`unsupported bun workspaces pattern: "${patternRaw}"`);
    }
    for (const dir of dirs) {
      if (!existsSync(join(repoPath, dir, "package.json"))) continue;
      const name = nameAt(dir);
      if (name) map.set(name, dir);
    }
  }
  return map;
}

/**
 * Pure half of the bun collector: parse the ASCII table `bun outdated -r` prints
 * (it has no JSON output and exits 0 whether or not updates exist —
 * oven-sh/bun#15648). Fail-closed: an unknown line, column set, package
 * annotation, or unmapped workspace throws instead of yielding silently-wrong
 * candidates, so a format change in a future bun version turns the run red.
 * devDependencies carry a ` (dev)` suffix in the Package column; `latest`
 * deliberately comes from the Latest column (registry latest, matching
 * npm/pnpm), not the range-bound Update column. Occurrences of one package
 * across workspaces (separate rows) are merged: lowest `current`, union
 * `locations` (resolved to paths via `workspaces`), dev only if every
 * occurrence is a devDependency.
 */
export function parseBunOutdated(raw: string, workspaces: Map<string, string>): Candidate[] {
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

  interface Acc {
    currents: string[];
    latest: string;
    locations: Set<string>;
    allDev: boolean;
  }
  const merged = new Map<string, Acc>();
  for (const row of rows) {
    const [pkgCell = "", current = "", , latest = "", workspaceName = ""] = row;
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
    const location = workspaces.get(workspaceName);
    if (location === undefined) {
      throw new Error(`unknown workspace "${workspaceName}" in bun outdated output`);
    }
    let acc = merged.get(m[1]);
    if (!acc) {
      acc = { currents: [], latest, locations: new Set(), allDev: true };
      merged.set(m[1], acc);
    }
    if (current) acc.currents.push(current);
    acc.latest = latest;
    acc.locations.add(location);
    if (m[2] !== "dev") acc.allDev = false;
  }

  const out: Candidate[] = [];
  for (const [name, acc] of merged) {
    const current = lowestVersion(acc.currents);
    out.push({
      name,
      current,
      latest: acc.latest,
      kind: acc.allDev ? "dev" : "prod",
      updateType: classifyUpdate(current, acc.latest),
      locations: [...acc.locations].sort(),
      currents: [...new Set(acc.currents)].sort(),
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
    // Resolved outside the try so an unsupported workspaces glob surfaces its own
    // clear error instead of the generic "not parseable" wrapper below.
    const workspaces = bunWorkspaceMap(repoPath);
    try {
      return parseBunOutdated(raw, workspaces);
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
  if (pm.name === "pnpm") return parsePnpmOutdated(data, repoPath);
  return parseOutdated(data);
}
