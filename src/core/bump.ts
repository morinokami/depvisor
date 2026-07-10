import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Document, isScalar, parseDocument } from "yaml";
import { colorFreeSpawnEnv } from "./collect.ts";
import { tail } from "./text.ts";

/**
 * Deterministic executor for the update plan `pm.updatePlan` builds. The
 * workflow applies every dependency bump/install with this LLM-free code before
 * any agent runs, so the installed version and the manifest/branch identity stay
 * fully deterministic (PR-identity parity — the plan's commands, the manifest
 * shapes they write, and the resulting branch name are all fixed by code).
 *
 * The one edit that is not a spawned command is pnpm's catalog hand-edit: pnpm
 * has no command that moves a `catalog:` entry to a specific version (it
 * de-catalogs instead — see pm.ts), so the entry is rewritten through the `yaml`
 * Document API, which round-trips comments and formatting. It is FAIL-CLOSED: a
 * missing entry, an unparseable file, or a non-string existing value is a hard
 * failure, never a silent skip — a botched catalog edit that slipped through as
 * "no change" would ship a PR that does not actually bump the catalog.
 *
 * Command spawns mirror collect.ts (no shell, FORCE_COLOR stripped) and
 * install.ts's rationale (a 15-minute per-command timeout so a hung install
 * cannot eat the CI job). Expected failures are returned as values with a
 * bounded output tail; this never throws for them.
 */

/**
 * One pnpm-workspace.yaml catalog entry to move to `target` (pnpm only).
 * `catalog` names WHICH catalog the referencing workspace pointed at: `null` is
 * the default catalog (a `catalog:` specifier — pnpm's sugar for
 * `catalog:default`), and a string is a named catalog (`catalog:<name>`). The
 * executor resolves a default edit to `catalog.<name>` or, failing that,
 * `catalogs.default.<name>`; a named edit only to `catalogs.<catalog>.<name>`.
 */
export interface CatalogEdit {
  name: string;
  target: string;
  catalog: string | null;
}

/**
 * A deterministic dependency update, ready to apply. `catalogEdits` (empty for
 * npm/bun) are applied FIRST, then `commands` are spawned in order without a
 * shell (cwd = repo). `pinExact` is carried from the plan builder for the
 * catalog range-style decision in `applyUpdatePlan`: under it the rewritten
 * catalog entry is always exact, never a preserved `^`/`~` range, so a follow-up
 * install cannot resolve past the vetted version (the same reasoning that drops
 * bun's caret under the minimum_release_age cooldown — see pm.ts).
 *
 * `blockers` (pnpm only, normally absent) are human-readable reasons the plan
 * cannot be applied safely — a member declared both as a `catalog:` reference
 * and a plain version across workspaces (mixed: `pnpm -r update` would
 * de-catalog the reference AND a catalog-only edit would leave the plain
 * declaration stale — neither is safe), or an unreadable declaring package.json.
 * `applyUpdatePlan` fails closed (`bump-failed`) before touching anything when
 * they are present.
 */
export interface UpdatePlan {
  catalogEdits: CatalogEdit[];
  commands: string[][];
  pinExact: boolean;
  blockers?: string[];
}

/**
 * Outcome of applying an update plan. `ok:false` names the failing `step` (a
 * command argv joined by spaces, or the catalog edit), the process exit `code`
 * (null when there is no process — a catalog edit, a spawn error, or a timeout),
 * and a bounded tail of the combined stdout+stderr for diagnostics.
 */
export type ApplyPlanResult =
  | { ok: true }
  | { ok: false; step: string; code: number | null; outputTail: string };

const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";
const CATALOG_STEP = `catalog edit (${PNPM_WORKSPACE_FILE})`;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Document path of an edit's catalog entry, resolved from the catalog the
 * referencing workspace named (`edit.catalog`). A default reference (`null`)
 * resolves to `catalog.<name>` or, failing that, `catalogs.default.<name>`
 * (pnpm treats a bare `catalog:` as sugar for `catalog:default`, and the default
 * catalog can be declared either way). A named reference resolves ONLY to
 * `catalogs.<catalog>.<name>`. null when the entry is absent (the fail-closed
 * "missing entry" case).
 */
function catalogPathFor(doc: Document, edit: CatalogEdit): (string | number)[] | null {
  const { name, catalog } = edit;
  if (catalog === null) {
    if (doc.hasIn(["catalog", name])) return ["catalog", name];
    if (doc.hasIn(["catalogs", "default", name])) return ["catalogs", "default", name];
    return null;
  }
  if (doc.hasIn(["catalogs", catalog, name])) return ["catalogs", catalog, name];
  return null;
}

/**
 * Preserve the existing range style unless `pinExact`: an entry written `^x`/`~x`
 * keeps its prefix on the new target; an exact entry (or any `pinExact` edit)
 * becomes the bare target.
 */
function rangeStyled(existing: string, target: string, pinExact: boolean): string {
  if (!pinExact && (existing.startsWith("^") || existing.startsWith("~"))) {
    return `${existing.charAt(0)}${target}`;
  }
  return target;
}

/**
 * Apply the catalog edits to pnpm-workspace.yaml in one round-trip, mutating each
 * located scalar in place so comments/anchors/formatting survive. Fail-closed on
 * a read/parse error, a missing entry, or a non-string existing value.
 */
function applyCatalogEdits(
  repoPath: string,
  edits: readonly CatalogEdit[],
  pinExact: boolean,
): { ok: true } | { ok: false; outputTail: string } {
  const file = join(repoPath, PNPM_WORKSPACE_FILE);
  let doc: Document;
  try {
    doc = parseDocument(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, outputTail: `cannot read ${PNPM_WORKSPACE_FILE}: ${messageOf(err)}` };
  }
  if (doc.errors.length > 0) {
    return {
      ok: false,
      outputTail: `unparseable ${PNPM_WORKSPACE_FILE}: ${doc.errors[0]?.message ?? "parse error"}`,
    };
  }
  for (const edit of edits) {
    const path = catalogPathFor(doc, edit);
    if (!path) {
      return {
        ok: false,
        outputTail: `no catalog entry for "${edit.name}" in ${PNPM_WORKSPACE_FILE}`,
      };
    }
    const node = doc.getIn(path, true);
    if (!isScalar(node) || typeof node.value !== "string") {
      return { ok: false, outputTail: `catalog entry for "${edit.name}" is not a string version` };
    }
    node.value = rangeStyled(node.value, edit.target, pinExact);
  }
  try {
    writeFileSync(file, doc.toString());
  } catch (err) {
    return { ok: false, outputTail: `cannot write ${PNPM_WORKSPACE_FILE}: ${messageOf(err)}` };
  }
  return { ok: true };
}

/**
 * Apply an update plan to `repoPath`: catalog edits first, then each command in
 * order. Returns the first failure (never throwing for expected failures) or
 * `ok:true` when everything succeeded.
 */
export function applyUpdatePlan(repoPath: string, plan: UpdatePlan): ApplyPlanResult {
  // Fail closed before touching anything if the plan builder flagged a shape it
  // cannot apply safely (a mixed catalog/plain declaration, an unreadable
  // manifest). Surfaces as `bump-failed`, whose summary prints step + tail.
  if (plan.blockers && plan.blockers.length > 0) {
    return { ok: false, step: "plan", code: null, outputTail: tail(plan.blockers.join("; ")) };
  }
  if (plan.catalogEdits.length > 0) {
    const res = applyCatalogEdits(repoPath, plan.catalogEdits, plan.pinExact);
    if (!res.ok)
      return { ok: false, step: CATALOG_STEP, code: null, outputTail: tail(res.outputTail) };
  }

  const env = colorFreeSpawnEnv();
  for (const argv of plan.commands) {
    const [cmd, ...args] = argv;
    if (cmd === undefined) continue; // defensive: an empty argv is a no-op
    const step = argv.join(" ");
    const res = spawnSync(cmd, args, {
      cwd: repoPath,
      encoding: "utf8",
      env,
      timeout: COMMAND_TIMEOUT_MS,
    });
    const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.error) {
      // Could not launch, or the timeout fired (ETIMEDOUT) — no exit code.
      return {
        ok: false,
        step,
        code: null,
        outputTail: tail(`${combined}${messageOf(res.error)}`),
      };
    }
    const code = res.status ?? 1;
    if (code !== 0) return { ok: false, step, code, outputTail: tail(combined) };
  }
  return { ok: true };
}
