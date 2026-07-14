/**
 * A verification-stage guard for the target repository's complete ref namespace.
 *
 * Target lifecycle and verification scripts run with `.git` reachable, so a
 * job snapshots every ref before its first untrusted execution, records each
 * deliberate branch/commit write, and verifies both the ref set and HEAD after
 * every untrusted boundary. This class closes that bookkeeping into one place:
 * callers still own policy because the same restored drift is fatal after
 * target code and restored before any result crosses the job boundary.
 *
 * Expected values must come from trusted code immediately after its own write;
 * never call `expect` with a sha read after untrusted target code has run.
 */

import { refDrift, restoreRefs, revParse, snapshotRefs } from "./git.ts";

export interface RestoredRefDrift {
  /** Moved, created, or deleted refs. Empty means only HEAD moved. */
  refs: string[];
}

export class RefGuard {
  readonly #repo: string;
  readonly #expected: Map<string, string>;

  private constructor(repo: string) {
    this.#repo = repo;
    this.#expected = snapshotRefs(repo);
  }

  /** Snapshot every ref before this job's first untrusted execution. */
  static capture(repo: string): RefGuard {
    return new RefGuard(repo);
  }

  /** Record a deliberate trusted write to one full ref name. */
  expect(ref: string, sha: string): void {
    this.#expected.set(ref, sha);
  }

  /** Convenience for the workflow's deliberate update-branch writes. */
  expectBranch(branch: string, sha: string): void {
    this.expect(`refs/heads/${branch}`, sha);
  }

  /** Restore every ref and reattach HEAD to `checkoutRef`. */
  restore(checkoutRef: string): void {
    restoreRefs(this.#repo, this.#expected, checkoutRef);
  }

  /**
   * Verify refs and the immutable HEAD anchor. On drift, restore the complete
   * trusted state before returning evidence for the caller's policy decision.
   */
  intactAt(head: string, checkoutRef: string): RestoredRefDrift | null {
    const refs = refDrift(this.#repo, this.#expected);
    if (refs.length === 0 && revParse(this.#repo, "HEAD") === head) return null;
    this.restore(checkoutRef);
    return { refs };
  }
}
