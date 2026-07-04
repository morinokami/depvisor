import { resolve } from "node:path";
import { collectCandidates } from "../core/collect.ts";
import { groupCandidates } from "../core/grouping.ts";
import { detectPackageManager } from "../core/pm.ts";
import { parseVerifyCommands, runVerification, verifyStepsFor } from "../core/verify.ts";

/**
 * depvisor scan — a developer-only tool (no LLM, no API key). It runs the
 * deterministic core (collect → group → verify) against a repo and prints the
 * result, so a human can eyeball the pipeline without going through the agent.
 * It is not part of the CI/composite-action flow — hence its home under dev/.
 *
 *   node src/dev/scan.ts [repoPath] [--verify]
 */

function main(): void {
  const args = process.argv.slice(2);
  const repoArg = args.find((a) => !a.startsWith("--")) ?? "fixtures/sample-app";
  const repoPath = resolve(process.cwd(), repoArg);
  const doVerify = args.includes("--verify");

  console.log(`\ndepvisor scan → ${repoPath}\n`);

  const detected = detectPackageManager(repoPath);
  if (!detected.ok) {
    console.log(`${detected.status}: ${detected.summary}\n`);
    process.exitCode = 1;
    return;
  }
  const pm = detected.pm;
  console.log(`Package manager: ${pm.name} — detected via ${detected.source}\n`);

  const candidates = collectCandidates(repoPath, pm);
  if (candidates.length === 0) {
    console.log("No outdated dependencies found.\n");
    return;
  }

  console.log(`Found ${candidates.length} outdated package(s):`);
  for (const c of candidates) {
    console.log(`  ${c.name.padEnd(22)} ${c.current} → ${c.latest}  [${c.updateType}, ${c.kind}]`);
  }

  const groups = groupCandidates(candidates);
  console.log(`\nProposed ${groups.length} group(s) — stable keys become branch/PR identity:`);
  for (const g of groups) {
    console.log(`\n  ▸ ${g.key}`);
    console.log(`    ${g.reason}`);
    for (const m of g.members) console.log(`      - ${m.name} (${m.current} → ${m.latest})`);
  }
  const skipped = candidates.filter((c) => c.updateType === "unknown");
  if (skipped.length > 0) {
    console.log(
      `\nSkipped (unknown update type — latest not ahead of current): ${skipped.map((c) => c.name).join(", ")}`,
    );
  }

  if (doVerify) {
    // Same precedence as the workflow: explicit commands replace auto-detection.
    const custom = parseVerifyCommands(process.env.DEPVISOR_VERIFY_COMMANDS || "");
    const steps = custom.length > 0 ? custom : verifyStepsFor(repoPath, pm);
    if (steps.length === 0) {
      console.log(
        "\nNo verification scripts (build/lint/test) found in package.json " +
          "and DEPVISOR_VERIFY_COMMANDS is not set.",
      );
    } else {
      console.log(`\nRunning verification gate (${steps.map((s) => s.name).join(" → ")})...`);
      const results = runVerification(repoPath, steps);
      for (const r of results) {
        console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} (exit ${r.code})`);
      }
    }
  }

  console.log("");
}

main();
