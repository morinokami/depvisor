/**
 * Bounded extraction of untrusted gzipped npm tarballs without executing tar.
 *
 * The parser accepts only regular-file entries with lexically safe relative
 * paths — symlinks, devices, and traversal names are dropped — so nothing
 * extracted here can escape or alias the directory it is later written into.
 * Entry count and unpacked size are capped before any content is returned.
 */

import { gunzipSync } from "node:zlib";
import { isSafeRepoPath } from "./paths.ts";

const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_TARBALL_ENTRIES = 20_000;

function parseOctal(field: Buffer): number {
  if (((field[0] ?? 0) & 0x80) !== 0) throw new Error("Unsupported tar size encoding.");
  const text = field.toString("ascii").replaceAll("\0", " ").trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid tar entry size.");
  return value;
}

function headerField(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function headerName(header: Buffer): string {
  const name = headerField(header, 0, 100);
  const prefix = headerField(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

/** Extract the `path` record from a pax extended header body, if present. */
function paxPath(body: Buffer): string | null {
  const text = body.toString("utf8");
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(" ", index);
    if (space === -1) return null;
    const length = Number.parseInt(text.slice(index, space), 10);
    if (!Number.isSafeInteger(length) || length <= space - index + 1) return null;
    const record = text.slice(space + 1, index + length);
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") {
      return record.slice(equals + 1).replace(/\n$/, "");
    }
    index += length;
  }
  return null;
}

/** Drop the tarball's single top-level directory (usually `package/`). */
function stripPackagePrefix(name: string): string | null {
  const normalized = name.startsWith("./") ? name.slice(2) : name;
  const slash = normalized.indexOf("/");
  if (slash === -1) return null;
  const rest = normalized.slice(slash + 1);
  return rest || null;
}

/** Read regular files out of a gzipped npm tarball. */
export function extractPackageFiles(tarball: Buffer): Map<string, Buffer> {
  const data = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files = new Map<string, Buffer>();
  let offset = 0;
  let entries = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > MAX_TARBALL_ENTRIES) throw new Error("The package tarball has too many entries.");
    const size = parseOctal(header.subarray(124, 136));
    const body = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const typeflag = header[156] ?? 0;
    if (typeflag === 0x4c) {
      pendingLongName = body.toString("utf8").replaceAll("\0", "");
      continue;
    }
    if (typeflag === 0x78) {
      pendingPaxPath = paxPath(body);
      continue;
    }
    if (typeflag === 0x67) continue;
    const name = pendingPaxPath ?? pendingLongName ?? headerName(header);
    pendingLongName = null;
    pendingPaxPath = null;
    if (typeflag !== 0x30 && typeflag !== 0) continue;
    const relative = stripPackagePrefix(name);
    if (relative === null || !isSafeRepoPath(relative)) continue;
    files.set(relative, Buffer.from(body));
  }
  return files;
}
