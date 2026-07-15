import { isValidNpmName } from "./changelog.ts";

/**
 * Packument fetch for display/prompt inputs: the reviewer report's source links
 * and the release notes fed to the digest agent. Fail-open by design — null
 * means "no metadata", never a stopped run — because nothing here gates the
 * repair or the verification verdict. One fetch per package per run: the
 * workflow keeps the returned map and every consumer reads from it.
 */

const NPM_REGISTRY = "https://registry.npmjs.org";

// Hung registries degrade to "no metadata" instead of stalling the run; one
// budget per packument, mirroring changelog.ts.
const FETCH_TIMEOUT_MS = 10_000;

/** The slice of an npm packument the report (links, release notes) needs. */
export interface Packument {
  repository?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Fetch a package's packument from the fixed npm registry endpoint. Only the
 * endpoint is fixed here; callers supply nothing but the package name, and an
 * invalid name never leaves the process. Returns null on any failure.
 */
export async function fetchPackument(
  pkg: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Packument | null> {
  if (!isValidNpmName(pkg)) return null;
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${NPM_REGISTRY}/${pkg}`, {
      headers: { accept: "application/json", "user-agent": "depvisor" },
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const meta: unknown = await res.json();
    if (!isRecord(meta)) return null;
    const packument: Packument = {};
    if ("repository" in meta) packument.repository = meta.repository;
    return packument;
  } catch {
    return null;
  }
}
