/** Bounded primary-source evidence enrichment, currently for npm packages. */

import { fetchReleaseNotes } from "./changelog.ts";
import type { DependencyChange } from "./types.ts";

const MAX_RELEASE_NOTES_PER_CHANGE = 8;
const MAX_RELEASE_NOTE_CHARS = 2_000;

export async function collectEvidence(
  changes: readonly DependencyChange[],
): Promise<DependencyChange[]> {
  return Promise.all(
    changes.map(async (change) => {
      if (
        change.ecosystem !== "javascript" ||
        change.package.startsWith("(") ||
        change.from === null ||
        change.to === null
      ) {
        return change;
      }
      const notes = await fetchReleaseNotes({
        package: change.package,
        from: change.from,
        to: change.to,
      });
      const evidence = [...change.evidence];
      for (const release of notes.releases.slice(0, MAX_RELEASE_NOTES_PER_CHANGE)) {
        evidence.push({
          kind: "release-note" as const,
          source: notes.source ? `https://github.com/${notes.source}/releases` : change.package,
          summary:
            release.notes.length <= MAX_RELEASE_NOTE_CHARS
              ? release.notes
              : `${release.notes.slice(0, MAX_RELEASE_NOTE_CHARS)}\n…(truncated)`,
          untrusted: true as const,
        });
      }
      return { ...change, evidence };
    }),
  );
}
