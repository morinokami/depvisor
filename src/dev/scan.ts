import { resolve } from "node:path";
import { collectCandidates } from "../core/collect.ts";
import { groupCandidates, parseGroups } from "../core/grouping.ts";
import { detectPackageManager } from "../core/pm.ts";
import { applyReleaseAge, parseMinimumReleaseAge } from "../core/release-age.ts";
import { parseVerifyCommands, runVerification, verifyStepsFor } from "../core/verify.ts";

/**
 * depvisor scan — a developer-only tool (no LLM, no API key). It runs the
 * deterministic core (collect → group → verify) against a repo and prints the
 * result, so a human can eyeball the pipeline without going through the agent.
 * It is not part of the CI/composite-action flow — hence its home under dev/.
 *
 *   node src/dev/scan.ts [repoPath] [--verify] [--expect-updates] [--minimum-release-age=<days>]
 *
 * --minimum-release-age applies the workflow's cooldown clamp (opt-in here, so the
 * default scan stays offline); it hits the real npm registry.
 * DEPVISOR_GROUPS is honored like in the workflow, so user-declared grouping
 * can be eyeballed here too.
 *
 * Exit code is nonzero when a --verify step fails or --verify finds no steps
 * (mirroring the workflow's fail-closed no-verify-scripts), and — with
 * --expect-updates — when collect surfaces zero candidates. That last flag is
 * the CI fixture-e2e canary: the fixtures are outdated by construction, so an
 * empty collect there means a PM's output format drifted and the parser broke
 * silently, exactly what the CI job exists to catch.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoArg = args.find((a) => !a.startsWith("--")) ?? "fixtures/sample-app";
  const repoPath = resolve(process.cwd(), repoArg);
  const doVerify = args.includes("--verify");
  const expectUpdates = args.includes("--expect-updates");
  const ageArg = args.find((a) => a.startsWith("--minimum-release-age="));
  const minimumReleaseAge = ageArg
    ? parseMinimumReleaseAge(ageArg.slice("--minimum-release-age=".length))
    : 0;
  if (minimumReleaseAge === null) {
    console.log(`--minimum-release-age must be a non-negative integer (days): "${ageArg}"\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\ndepvisor scan → ${repoPath}\n`);

  const detected = detectPackageManager(repoPath);
  if (!detected.ok) {
    console.log(`${detected.status}: ${detected.summary}\n`);
    process.exitCode = 1;
    return;
  }
  const pm = detected.pm;
  console.log(`Package manager: ${pm.name} — detected via ${detected.source}\n`);

  let candidates = collectCandidates(repoPath, pm);
  if (candidates.length === 0) {
    console.log("No outdated dependencies found.\n");
    if (expectUpdates) {
      console.log("--expect-updates: zero candidates on a repo that should have some.\n");
      process.exitCode = 1;
    }
    return;
  }

  console.log(`Found ${candidates.length} outdated package(s):`);
  for (const c of candidates) {
    console.log(`  ${c.name.padEnd(22)} ${c.current} → ${c.latest}  [${c.updateType}, ${c.kind}]`);
  }

  if (minimumReleaseAge > 0) {
    console.log(`\nApplying minimum release age of ${minimumReleaseAge} day(s) (npm registry)...`);
    const aged = await applyReleaseAge(candidates, minimumReleaseAge);
    for (const c of aged.clamped) console.log(`  clamped    ${c.name} ${c.from} → ${c.to}`);
    for (const c of aged.heldBack) {
      console.log(`  held back  ${c.name} (no version newer than ${c.current} is old enough)`);
    }
    for (const c of aged.unavailable) {
      console.log(`  dropped    ${c.name} (release age unverifiable — the workflow reports red)`);
    }
    if (aged.clamped.length + aged.heldBack.length + aged.unavailable.length === 0) {
      console.log("  every candidate's latest is already mature");
    }
    candidates = aged.kept;
    if (candidates.length === 0) {
      console.log("\nNo candidates remain after the release-age clamp.\n");
      return;
    }
  }

  const parsedGroups = parseGroups(process.env.DEPVISOR_GROUPS || "");
  if (!parsedGroups.ok) {
    console.log(`\nbad-groups: ${parsedGroups.problems.join("; ")}\n`);
    process.exitCode = 1;
    return;
  }

  const groups = groupCandidates(candidates, parsedGroups.rules);
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
      process.exitCode = 1;
    } else {
      console.log(`\nRunning verification gate (${steps.map((s) => s.name).join(" → ")})...`);
      const results = runVerification(repoPath, steps);
      for (const r of results) {
        console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} (exit ${r.code})`);
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    }
  }

  console.log("");
}

await main();
