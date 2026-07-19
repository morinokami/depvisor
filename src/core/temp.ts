/** Disposable temp directory: `using dir = tempDir(prefix)` removes it on scope exit. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(prefix: string): { readonly path: string } & Disposable {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }),
  };
}
