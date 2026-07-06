import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLicenseChanges,
  describeLicenseChanges,
  versionLicense,
} from "../src/core/license.ts";
import type { Packument } from "../src/core/release-age.ts";
import type { Candidate } from "../src/core/types.ts";

/** A packument whose `versions` map carries whatever license shapes the test needs. */
function packument(versions: Record<string, unknown>): Packument {
  return { versions };
}

function cand(partial: Partial<Candidate> & { name: string }): Candidate {
  return {
    current: "1.0.0",
    latest: "2.0.0",
    kind: "prod",
    updateType: "major",
    locations: [""],
    ...partial,
  };
}

test("versionLicense returns the plain string license, trimmed", () => {
  const p = packument({ "1.0.0": { license: "  MIT  " }, "2.0.0": { license: "BUSL-1.1" } });
  assert.equal(versionLicense(p, "1.0.0"), "MIT");
  assert.equal(versionLicense(p, "2.0.0"), "BUSL-1.1");
});

test("versionLicense treats unknown shapes as null (fail-open)", () => {
  const p = packument({
    "1.0.0": { license: { type: "MIT", url: "https://opensource.org/MIT" } }, // deprecated object form
    "2.0.0": { licenses: [{ type: "ISC" }] }, // ancient array form, no `license`
    "3.0.0": { license: "" }, // blank
    "4.0.0": { license: "   " }, // whitespace only
    "5.0.0": {}, // missing field
    "6.0.0": "not-an-object", // non-record manifest
  });
  assert.equal(versionLicense(p, "1.0.0"), null);
  assert.equal(versionLicense(p, "2.0.0"), null);
  assert.equal(versionLicense(p, "3.0.0"), null);
  assert.equal(versionLicense(p, "4.0.0"), null);
  assert.equal(versionLicense(p, "5.0.0"), null);
  assert.equal(versionLicense(p, "6.0.0"), null);
});

test("versionLicense returns null for an absent version or an empty packument", () => {
  const p = packument({ "1.0.0": { license: "MIT" } });
  assert.equal(versionLicense(p, "9.9.9"), null);
  assert.equal(versionLicense({}, "1.0.0"), null);
});

test("classifyLicenseChanges reports only members whose known license changed", () => {
  const packuments = new Map<string, Packument | null>([
    // Changed: ISC -> BUSL-1.1.
    ["lru-cache", packument({ "6.0.0": { license: "ISC" }, "11.0.0": { license: "BUSL-1.1" } })],
    // Unchanged: MIT both sides.
    ["lodash", packument({ "1.0.0": { license: "MIT" }, "2.0.0": { license: "MIT" } })],
    // Unknown target side (object form) — skipped, no phantom change.
    ["semver", packument({ "1.0.0": { license: "ISC" }, "2.0.0": { license: { type: "ISC" } } })],
    // Fetch failed for this package — skipped.
    ["chalk", null],
  ]);
  const members = [
    cand({ name: "lru-cache", current: "6.0.0", latest: "11.0.0" }),
    cand({ name: "lodash", current: "1.0.0", latest: "2.0.0" }),
    cand({ name: "semver", current: "1.0.0", latest: "2.0.0" }),
    cand({ name: "chalk", current: "1.0.0", latest: "2.0.0" }),
    // No packument entry at all — skipped.
    cand({ name: "uncached", current: "1.0.0", latest: "2.0.0" }),
  ];
  assert.deepEqual(classifyLicenseChanges(members, packuments), [
    { name: "lru-cache", from: "ISC", to: "BUSL-1.1" },
  ]);
});

test("describeLicenseChanges is empty when nothing changed and lists changes otherwise", () => {
  assert.equal(describeLicenseChanges([]), "");
  assert.equal(
    describeLicenseChanges([
      { name: "lru-cache", from: "ISC", to: "BUSL-1.1" },
      { name: "foo", from: "MIT", to: "GPL-3.0-only" },
    ]),
    "license change(s) detected: lru-cache ISC -> BUSL-1.1, foo MIT -> GPL-3.0-only.",
  );
});
