/**
 * The deterministic dry-run plan: the update workflow emits this alongside
 * status.json after candidate selection, grouping, advisory prioritization,
 * branch-collision detection, and open-PR classification. It deliberately
 * stops before baseline verification or any bump, so new-PR dispositions are
 * optimistic projections rather than promises: each provisional open-new is
 * assumed to succeed and consume a slot before the next group is classified.
 *
 * The file is read back by report-status.ts, not written directly to
 * $GITHUB_STEP_SUMMARY. That keeps the existing untrusted read-back boundary:
 * every field is schema-validated and Markdown-sanitized before display.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { classifyGroup } from "./budget.ts";
import { DRY_RUN_PLAN_FILE } from "./dry-run-plan-file.ts";
import {
  branchNameForGroup,
  extractVersionsMarker,
  sanitizeSummary,
  versionsMarker,
} from "./pr.ts";
import { statusPackages, type StatusPackage } from "./status.ts";
import type { Group } from "./types.ts";

export { DRY_RUN_PLAN_FILE };

export function parseDryRun(raw: string): boolean | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "false") return false;
  if (trimmed === "true") return true;
  return null;
}

export type DryRunDisposition =
  | "refresh"
  | "skip-up-to-date"
  | "open-new-provisional"
  | "held-back-provisional"
  | "branch-collision";

export interface DryRunGroupPlan {
  key: string;
  branch: string;
  packages: StatusPackage[];
  disposition: DryRunDisposition;
}

export interface DryRunPlan {
  collected: StatusPackage[];
  ignored: { package: StatusPackage; rule: string }[];
  cooldown: {
    minimumReleaseAge: number;
    clamped: { name: string; from: string; to: string }[];
    excluded: StatusPackage[];
    heldBack: StatusPackage[];
    unavailable: StatusPackage[];
  };
  groups: DryRunGroupPlan[];
  budget: {
    openPullRequestsLimit: number;
    openDepvisorPrCount: number;
    initialNewSlots: number;
  };
  notes: {
    ignore: string;
    releaseAge: string;
    advisories: string;
  };
}

/**
 * Classify every group for display without running it. Unlike the production
 * loop, this has no processGroup outcome to tell it whether a new PR was
 * actually prepared, so it consumes each projected slot optimistically and
 * labels both new-PR outcomes provisional.
 */
export function planDryRunGroups(
  groups: readonly Group[],
  bodyByBranch: ReadonlyMap<string, string>,
  initialNewSlots: number,
): DryRunGroupPlan[] {
  const planned: DryRunGroupPlan[] = [];
  const seenBranches = new Set<string>();
  let newSlots = initialNewSlots;

  for (const group of groups) {
    const branch = branchNameForGroup(group.key);
    if (seenBranches.has(branch)) {
      planned.push({
        key: group.key,
        branch,
        packages: statusPackages(group.members),
        disposition: "branch-collision",
      });
      continue;
    }
    seenBranches.add(branch);

    const hasOpenPr = bodyByBranch.has(branch);
    const upToDate =
      extractVersionsMarker(bodyByBranch.get(branch) ?? "") === versionsMarker(group.members);
    const disposition = classifyGroup({ hasOpenPr, upToDate, newSlots });
    let plannedDisposition: DryRunDisposition;
    if (disposition === "open-new") {
      plannedDisposition = "open-new-provisional";
      newSlots -= 1;
    } else if (disposition === "held-back") {
      plannedDisposition = "held-back-provisional";
    } else {
      plannedDisposition = disposition;
    }
    planned.push({
      key: group.key,
      branch,
      packages: statusPackages(group.members),
      disposition: plannedDisposition,
    });
  }
  return planned;
}

const statusPackageSchema = v.object({
  name: v.string(),
  current: v.string(),
  latest: v.string(),
  kind: v.picklist(["prod", "dev"]),
  updateType: v.picklist(["patch", "minor", "major", "unknown"]),
});

const planSchema = v.object({
  collected: v.array(statusPackageSchema),
  ignored: v.array(v.object({ package: statusPackageSchema, rule: v.string() })),
  cooldown: v.object({
    minimumReleaseAge: v.number(),
    clamped: v.array(v.object({ name: v.string(), from: v.string(), to: v.string() })),
    excluded: v.array(statusPackageSchema),
    heldBack: v.array(statusPackageSchema),
    unavailable: v.array(statusPackageSchema),
  }),
  groups: v.array(
    v.object({
      key: v.string(),
      branch: v.string(),
      packages: v.array(statusPackageSchema),
      disposition: v.picklist([
        "refresh",
        "skip-up-to-date",
        "open-new-provisional",
        "held-back-provisional",
        "branch-collision",
      ]),
    }),
  ),
  budget: v.object({
    openPullRequestsLimit: v.number(),
    openDepvisorPrCount: v.number(),
    initialNewSlots: v.number(),
  }),
  notes: v.object({
    ignore: v.string(),
    releaseAge: v.string(),
    advisories: v.string(),
  }),
});

export function dryRunPlanPath(outDir: string): string {
  return join(outDir, DRY_RUN_PLAN_FILE);
}

export function emitDryRunPlan(outDir: string, plan: DryRunPlan): string {
  mkdirSync(outDir, { recursive: true });
  const path = dryRunPlanPath(outDir);
  writeFileSync(path, JSON.stringify(plan, null, 2));
  return path;
}

export function readDryRunPlan(file: string): DryRunPlan | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const result = v.safeParse(planSchema, parsed);
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

function mdCell(value: string | number): string {
  return sanitizeSummary(String(value))
    .replace(/\s*\r?\n\s*/g, " ")
    .replaceAll("|", "\\|");
}

function packageRows(packages: readonly StatusPackage[]): string[] {
  return packages.map(
    (p) =>
      `| ${mdCell(p.name)} | ${mdCell(p.current)} | ${mdCell(p.latest)} | ${mdCell(p.kind)} | ${mdCell(p.updateType)} |`,
  );
}

function packageTable(title: string, packages: readonly StatusPackage[], empty: string): string {
  return [
    `### ${title}`,
    "",
    ...(packages.length > 0
      ? ["| Package | From | To | Kind | Type |", "|---|---|---|---|---|", ...packageRows(packages)]
      : [empty]),
    "",
  ].join("\n");
}

function ignoredTable(plan: DryRunPlan): string {
  const rows = plan.ignored.map(
    ({ package: p, rule }) =>
      `| ${mdCell(p.name)} | ${mdCell(p.current)} | ${mdCell(p.latest)} | ${mdCell(rule)} |`,
  );
  return [
    "### Ignored candidates",
    "",
    ...(rows.length > 0
      ? ["| Package | From | To | Rule |", "|---|---|---|---|", ...rows]
      : ["No candidate was ignored."]),
    "",
  ].join("\n");
}

function cooldownTable(plan: DryRunPlan): string {
  const rows = [
    ...plan.cooldown.clamped.map(
      (c) => `| ${mdCell(c.name)} | clamped | ${mdCell(c.from)} → ${mdCell(c.to)} |`,
    ),
    ...plan.cooldown.excluded.map(
      (p) => `| ${mdCell(p.name)} | excluded | minimum_release_age_exclude |`,
    ),
    ...plan.cooldown.heldBack.map((p) => `| ${mdCell(p.name)} | held-back | no mature update |`),
    ...plan.cooldown.unavailable.map(
      (p) => `| ${mdCell(p.name)} | unavailable | release age unverifiable |`,
    ),
  ];
  return [
    `### Cooldown (minimum_release_age=${mdCell(plan.cooldown.minimumReleaseAge)})`,
    "",
    ...(rows.length > 0
      ? ["| Package | Outcome | Detail |", "|---|---|---|", ...rows]
      : ["No candidate was changed or dropped by the cooldown."]),
    "",
  ].join("\n");
}

function groupTable(plan: DryRunPlan): string {
  const rows = plan.groups.map(
    (g) =>
      `| ${mdCell(g.key)} | ${mdCell(g.branch)} | ${mdCell(g.disposition)} | ${mdCell(g.packages.map((p) => p.name).join(", "))} |`,
  );
  return [
    "### Planned groups",
    "",
    ...(rows.length > 0
      ? ["| Group | Branch | Disposition | Packages |", "|---|---|---|---|", ...rows]
      : ["No update groups are currently planned."]),
    "",
    "_Provisional dispositions assume every earlier `open-new-provisional` group succeeds. A failed bump or verification leaves its slot available, so later new-PR dispositions can change in the real run._",
    "",
  ].join("\n");
}

export function renderDryRunPlan(plan: DryRunPlan): string {
  const notes = [plan.notes.ignore, plan.notes.releaseAge, plan.notes.advisories].filter(Boolean);
  return [
    "## Dry-run plan",
    "",
    "This is a selection plan only. It does not run the baseline checks, apply a bump, verify an update, or invoke the fixer/digest agents.",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Detected candidates | ${plan.collected.length} |`,
    `| Planned groups | ${plan.groups.length} |`,
    `| Open depvisor PRs | ${mdCell(plan.budget.openDepvisorPrCount)} |`,
    `| New-PR slots | ${mdCell(plan.budget.initialNewSlots)} / ${mdCell(plan.budget.openPullRequestsLimit)} |`,
    "",
    packageTable("Detected candidates", plan.collected, "No outdated dependency was detected."),
    ignoredTable(plan),
    cooldownTable(plan),
    groupTable(plan),
    ...(notes.length > 0 ? ["### Notes", "", ...notes.map((note) => `- ${mdCell(note)}`), ""] : []),
  ].join("\n");
}
