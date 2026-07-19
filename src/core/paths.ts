/**
 * The one lexical validator for untrusted repository-relative paths.
 *
 * Every path that crosses toward publication — updater-changed files, captured
 * fix paths, snapshot entries, captured new files — must pass this exact
 * rule set so no boundary is quietly looser than another. `.git` segments are
 * rejected as defense in depth: git cannot track such paths, so a path carrying
 * one is either corrupt or aimed at the metadata of a checkout or clone.
 */
export function isSafeRepoPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return path
    .split("/")
    .every(
      (segment) =>
        segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git",
    );
}
