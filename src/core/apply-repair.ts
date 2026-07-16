/** Safely materialize captured untracked files inside a fresh publication clone. */

import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { NewRepairFile } from "./git.ts";

function safePath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\0") || path.includes("\\")) {
    throw new Error(`Unsafe repair path: ${path}`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe repair path: ${path}`);
  }
  return absolute;
}

function ensureDirectories(root: string, parent: string): void {
  const rel = relative(root, parent);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if (!existsSync(current)) {
      mkdirSync(current);
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Repair path has a non-directory or symlink parent: ${relative(root, current)}`,
      );
    }
  }
}

export function materializeNewRepairFiles(root: string, files: readonly NewRepairFile[]): void {
  for (const file of files) {
    const absolute = safePath(root, file.path);
    ensureDirectories(root, dirname(absolute));
    if (existsSync(absolute)) {
      throw new Error(`Repair new-file path already exists: ${file.path}`);
    }
    const content = Buffer.from(file.contentBase64, "base64");
    if (file.symlink) symlinkSync(content.toString("utf8"), absolute);
    else {
      writeFileSync(absolute, content);
      chmodSync(absolute, file.executable ? 0o755 : 0o644);
    }
  }
}
