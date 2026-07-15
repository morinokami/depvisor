import { resolve } from "node:path";
import { classifyPrCommits, diffDependencies } from "../core/dep-diff.ts";
import {
  checkoutDetached,
  checkoutForce,
  currentBranch,
  mergeBase,
  revParse,
} from "../core/git.ts";
import { runInstall } from "../core/install.ts";
import { detectPackageManager } from "../core/pm.ts";
import { resolveResetCommand } from "../core/preflight.ts";
import { parseVerifyCommands, runVerification, verifyStepsFor } from "../core/verify.ts";

/**
 * depvisor scan — runs the deterministic aftercare core (PM detection → commit
 * classification → dependency diff → verification/attribution) against a repo
 * checked out on an updater-style branch, and prints the result. No LLM, no
 * API key. Two callers: a developer eyeballing the pipeline without going
 * through the agent, and CI's fixture-e2e job, which runs it per fixture
 * variant as the real-package-manager E2E gate. It is not part of the
 * composite action — hence its home under dev/.
 *
 *   node src/dev/scan.ts [repoPath] [--base=<ref>] [--verify[=green|broken]]
 *                        [--expect-changes=<name>[,<name>…]]
 *
 * --verify runs the head verification; `--verify=broken` additionally demands
 * the aftercare fixture scenario end-to-end — head RED, then merge-base
 * baseline GREEN under its own reinstalled lockfile state (attribution works),
 * then a clean return to head — and exits nonzero otherwise. `--verify=green`
 * demands a green head. --expect-changes names packages the dependency diff
 * must surface as DIRECT changes; a parser regression that shrinks the diff
 * fails the job instead of passing unnoticed.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoArg = args.find((a) => !a.startsWith("--")) ?? "fixtures/sample-app";
  const repoPath = resolve(process.cwd(), repoArg);
  const baseArg = args.find((a) => a.startsWith("--base="));
  const baseRef = baseArg ? baseArg.slice("--base=".length) : "main";
  const verifyArg = args.find((a) => a === "--verify" || a.startsWith("--verify="));
  const verifyMode = verifyArg?.startsWith("--verify=")
    ? verifyArg.slice("--verify=".length)
    : verifyArg
      ? "any"
      : null;
  if (verifyMode !== null && !["any", "green", "broken"].includes(verifyMode)) {
    console.log(`--verify must be bare, =green, or =broken: "${verifyArg}"\n`);
    process.exitCode = 1;
    return;
  }
  const expectArg = args.find((a) => a.startsWith("--expect-changes="));
  const expectations = (expectArg ?? "")
    .slice("--expect-changes=".length)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  console.log(`\ndepvisor scan → ${repoPath}\n`);

  const detected = detectPackageManager(repoPath);
  if (!detected.ok) {
    console.log(`${detected.status}: ${detected.summary}\n`);
    process.exitCode = 1;
    return;
  }
  const pm = detected.pm;
  console.log(`Package manager: ${pm.name} — detected via ${detected.source}`);

  const headRef = currentBranch(repoPath);
  const headSha = revParse(repoPath, "HEAD");
  const mergeBaseSha = mergeBase(repoPath, baseRef, "HEAD");
  if (!mergeBaseSha) {
    console.log(`No merge base between '${baseRef}' and HEAD.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Head: ${headRef} @ ${headSha.slice(0, 8)}; base: ${baseRef}; merge base: ${mergeBaseSha.slice(0, 8)}\n`,
  );
  if (mergeBaseSha === headSha) {
    console.log("The branch adds no commits beyond the base — nothing to analyze.\n");
    process.exitCode = 1;
    return;
  }

  const commits = classifyPrCommits(repoPath, mergeBaseSha, headSha);
  if (!commits.ok) {
    console.log("not-an-update-pr: commits touch non-dependency paths:");
    for (const f of commits.foreign) {
      console.log(`  ${f.sha.slice(0, 8)}: ${f.paths.join(", ")}`);
    }
    console.log("");
    process.exitCode = 1;
    return;
  }
  console.log(
    `Commit classification: ${commits.updaterCommits} updater commit(s), ${commits.ownCommits} depvisor repair commit(s)`,
  );

  const diff = diffDependencies(repoPath, mergeBaseSha, headSha, pm);
  console.log(
    `\nDependency diff (${diff.lockfileResolved ? "lockfile-resolved" : "manifest specifiers"}; ` +
      `${diff.changedFiles.length} dependency-state file(s) changed):`,
  );
  for (const c of diff.direct) {
    const where = c.locations.filter((l) => l !== "");
    const at = where.length > 0 ? `  @ ${where.join(", ")}` : "";
    console.log(`  ${c.name.padEnd(22)} ${c.from} → ${c.to}  [${c.updateType}, ${c.kind}]${at}`);
  }
  for (const t of diff.transitives.slice(0, 10)) {
    console.log(`  ${t.name.padEnd(22)} ${t.from} → ${t.to}  [transitive]`);
  }
  if (diff.transitives.length > 10) {
    console.log(`  (+ ${diff.transitives.length - 10} further transitive package(s) moved)`);
  }
  if (diff.direct.length === 0 && diff.transitives.length === 0) {
    console.log("  (no dependency change found)");
    process.exitCode = 1;
  }

  const missing = expectations.filter((name) => !diff.direct.some((c) => c.name === name));
  if (missing.length > 0) {
    console.log(`\n--expect-changes: missing direct change(s): ${missing.join(", ")}.`);
    process.exitCode = 1;
  }

  if (verifyMode !== null) {
    // Same precedence as the workflow: explicit commands replace auto-detection.
    const custom = parseVerifyCommands(process.env.DEPVISOR_VERIFY_COMMANDS || "");
    const steps = custom.length > 0 ? custom : verifyStepsFor(repoPath, pm);
    if (steps.length === 0) {
      console.log(
        "\nNo verification scripts (build/lint/test) found in package.json " +
          "and DEPVISOR_VERIFY_COMMANDS is not set.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`\nRunning head verification (${steps.map((s) => s.name).join(" → ")})...`);
    const headRun = runVerification(repoPath, steps);
    for (const r of headRun) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} (exit ${r.code})`);
    const headGreen = headRun.every((r) => r.ok);

    if (verifyMode === "green" && !headGreen) {
      console.log("\n--verify=green: the head verification failed.");
      process.exitCode = 1;
    }
    if (verifyMode === "any" && !headGreen) process.exitCode = 1;

    if (verifyMode === "broken") {
      if (headGreen) {
        console.log("\n--verify=broken: expected the head to fail verification, but it passed.");
        process.exitCode = 1;
      } else {
        // The attribution round-trip the workflow performs: baseline under the
        // merge base's own lockfile state, then a clean return to head.
        const resetCommand = resolveResetCommand(pm, repoPath, "auto");
        if (!resetCommand) {
          console.log("\n--verify=broken: no reinstall command (missing lockfile?).");
          process.exitCode = 1;
        } else {
          console.log(`\nBaseline attribution at ${mergeBaseSha.slice(0, 8)} (${resetCommand})...`);
          checkoutDetached(repoPath, mergeBaseSha);
          const baseInstall = runInstall(repoPath, resetCommand);
          const baseline = baseInstall.ok ? runVerification(repoPath, steps) : [];
          for (const r of baseline) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name} (exit ${r.code})`);
          const baselineGreen = baseInstall.ok && baseline.every((r) => r.ok);
          checkoutForce(repoPath, headRef);
          const headInstall = runInstall(repoPath, resetCommand);
          if (!baseInstall.ok) {
            console.log("  baseline install failed.");
            process.exitCode = 1;
          } else if (!baselineGreen) {
            console.log("  baseline-red: the merge base fails verification too.");
            process.exitCode = 1;
          } else if (!headInstall.ok) {
            console.log("  returning to head: reinstall failed.");
            process.exitCode = 1;
          } else {
            console.log(
              "  attribution OK: head red, baseline green — the failure is the update's.",
            );
          }
        }
      }
    }
  }

  console.log("");
}

await main();
