import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { asPlainMap } from "./manifest.ts";
import type { PmToolchain } from "./pm.ts";
import type { Candidate, DepKind, UpdateType } from "./types.ts";
import { compareTriple, parseVersionCore, type Triple } from "./version-core.ts";

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
  let lowestParsed: Triple | undefined;
  for (const v of versions) {
    const p = parseVersionCore(v);
    if (!p) continue;
    if (!lowestParsed || compareTriple(p, lowestParsed) < 0) {
      lowest = v;
      lowestParsed = p;
    }
  }
  return lowest ?? versions[0] ?? "";
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
  const c = parseVersionCore(current);
  const l = parseVersionCore(latest);
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
    const entries = (Array.isArray(infoRaw) ? infoRaw : [infoRaw]).map(asPlainMap);
    if (entries.some((entry) => entry === null)) {
      throw new Error(`malformed npm outdated entry for ${name}`);
    }
    const currents: string[] = [];
    const locations = new Set<string>();
    let latest = "";
    let allDev = entries.length > 0;
    for (const info of entries) {
      if (!info) continue;
      const cur = typeof info.current === "string" ? info.current : "";
      if (cur) currents.push(cur);
      const lat = typeof info.latest === "string" ? info.latest : "";
      if (lat) latest = lat; // registry `latest`, identical across occurrences
      locations.add(typeof info.dependedByLocation === "string" ? info.dependedByLocation : "");
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
      locations: [...locations].toSorted(),
      currents: [...new Set(currents)].toSorted(),
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
    const info = asPlainMap(infoRaw);
    if (!info) throw new Error(`malformed pnpm outdated entry for ${name}`);
    const current = typeof info.current === "string" ? info.current : "";
    const latest = typeof info.latest === "string" ? info.latest : "";
    if (!latest || latest === current) continue;
    const locations = new Set<string>();
    const dependentPackages = Array.isArray(info.dependentPackages) ? info.dependentPackages : [];
    for (const depRaw of dependentPackages) {
      const dep = asPlainMap(depRaw);
      if (!dep) throw new Error(`malformed pnpm dependent package for ${name}`);
      locations.add(
        relativeLocation(repoPath, typeof dep.location === "string" ? dep.location : undefined),
      );
    }
    if (locations.size === 0) locations.add(""); // defensive: treat as root
    const kind: DepKind = info.dependencyType === "devDependencies" ? "dev" : "prod";
    out.push({
      name,
      current,
      latest,
      kind,
      updateType: classifyUpdate(current, latest),
      locations: [...locations].toSorted(),
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
      const pkg = asPlainMap(JSON.parse(readFileSync(join(repoPath, dir, "package.json"), "utf8")));
      return typeof pkg?.name === "string" ? pkg.name : null;
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

  const rootPkg = asPlainMap(JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")));
  if (!rootPkg) throw new Error("root package.json is not an object");
  // bun accepts both the array form and npm's `{ packages: [...] }` object form.
  const ws = rootPkg.workspaces;
  const wsMap = asPlainMap(ws);
  const patterns = Array.isArray(ws) ? ws : Array.isArray(wsMap?.packages) ? wsMap.packages : [];

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
      locations: [...acc.locations].toSorted(),
      currents: [...new Set(acc.currents)].toSorted(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Spawn env for PM commands whose output is captured and parsed or tailed
 * (here and in bump.ts): FORCE_COLOR switches bun to box-drawing + ANSI output
 * even without a TTY, and it beats NO_COLOR (verified against bun 1.3.14) —
 * strip it and force NO_COLOR so captured output stays plain text.
 */
export function colorFreeSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
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
  const res = spawnSync(cmd, args, { cwd: repoPath, encoding: "utf8", env: colorFreeSpawnEnv() });
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
  if (!raw) {
    // npm/pnpm print JSON (at least `{}`) even when everything is current, and
    // their normal "updates exist" path is exit 1 WITH output — so empty output
    // plus a non-zero exit is a hard failure (e.g. a killed process), never "no
    // updates". Fail closed instead of reporting a green empty scan. bun's
    // non-zero exit already threw above.
    if (res.status !== 0) {
      const stderr = (res.stderr ?? "").trim();
      throw new Error(
        `${pm.name} outdated produced no output (exit ${res.status})` +
          (stderr ? `: ${stderr.slice(0, 200)}` : ""),
      );
    }
    return [];
  }

  if (pm.name === "bun") {
    // Resolved outside the try so an unsupported workspaces glob surfaces its own
    // clear error instead of the generic "not parseable" wrapper below.
    const workspaces = bunWorkspaceMap(repoPath);
    try {
      return parseBunOutdated(raw, workspaces);
    } catch (err) {
      const stderr = (res.stderr ?? "").trim();
      const message = Error.isError(err) ? err.message : String(err);
      throw new Error(
        `bun outdated output was not parseable (exit ${res.status}): ${message}` +
          (stderr ? ` — stderr: ${stderr.slice(0, 200)}` : ""),
        { cause: err },
      );
    }
  }

  let data: Record<string, unknown>;
  try {
    const parsed = asPlainMap(JSON.parse(raw));
    if (!parsed) throw new Error("root value is not an object");
    data = parsed;
  } catch {
    const stderr = (res.stderr ?? "").trim();
    throw new Error(
      `${pm.name} outdated produced non-JSON output (exit ${res.status}): ${raw.slice(0, 200)}` +
        (stderr ? ` — stderr: ${stderr.slice(0, 200)}` : ""),
    );
  }

  // With --json, npm reports hard failures (unreachable registry, broken
  // manifest, …) as an `error` OBJECT on stdout — the same exit 1 as the normal
  // "updates exist" path — and the parsers below would read that shape as zero
  // candidates, turning a registry outage into a green "no updates" run. A real
  // dependency named `error` still parses: its outdated entry (object or
  // per-workspace array) never carries `code`/`summary` keys.
  const errInfo = data.error;
  if (
    errInfo !== null &&
    typeof errInfo === "object" &&
    !("latest" in errInfo) &&
    ("code" in errInfo || "summary" in errInfo)
  ) {
    const code = "code" in errInfo ? errInfo.code : undefined;
    const summary = "summary" in errInfo ? errInfo.summary : undefined;
    throw new Error(
      `${pm.name} outdated failed (exit ${res.status}): ` +
        (typeof code === "string" ? `${code}: ` : "") +
        (typeof summary === "string" ? summary.slice(0, 200) : "unknown error"),
    );
  }

  if (pm.name === "pnpm") return parsePnpmOutdated(data, repoPath);
  return parseOutdated(data);
}
