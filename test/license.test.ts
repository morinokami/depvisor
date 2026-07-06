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

test("classifyLicenseChanges checks every workspace-current, not just the lowest", () => {
  // foo is MIT at 1.0.0 in one workspace and GPL at 2.0.0 in another, both moving
  // to 3.0.0 (MIT). Comparing only `current` (1.0.0 MIT -> 3.0.0 MIT) would miss
  // the relicense the GPL workspace crosses — mirror the advisory path's currents.
  const p = packument({
    "1.0.0": { license: "MIT" },
    "2.0.0": { license: "GPL-3.0-only" },
    "3.0.0": { license: "MIT" },
  });
  const member = cand({
    name: "foo",
    current: "1.0.0",
    latest: "3.0.0",
    currents: ["1.0.0", "2.0.0"],
  });
  assert.deepEqual(classifyLicenseChanges([member], new Map([["foo", p]])), [
    { name: "foo", from: "GPL-3.0-only", to: "MIT" },
  ]);
});

test("classifyLicenseChanges dedupes repeated from->to across workspace-currents", () => {
  // Two workspace-currents share the same MIT license; only one row is emitted.
  const p = packument({
    "1.0.0": { license: "MIT" },
    "1.5.0": { license: "MIT" },
    "2.0.0": { license: "BUSL-1.1" },
  });
  const member = cand({
    name: "foo",
    current: "1.0.0",
    latest: "2.0.0",
    currents: ["1.0.0", "1.5.0"],
  });
  assert.deepEqual(classifyLicenseChanges([member], new Map([["foo", p]])), [
    { name: "foo", from: "MIT", to: "BUSL-1.1" },
  ]);
});

test("describeLicenseChanges control-sanitizes registry license strings for the log", () => {
  const nl = String.fromCharCode(10); // LF
  const cr = String.fromCharCode(13); // CR
  const del = String.fromCharCode(127); // C0/C1 control
  // A hostile license: an embedded newline before Actions-command-looking text.
  const evil = `MIT${nl}::error::pwned${cr}${del}x`;
  const line = describeLicenseChanges([{ name: "foo", from: evil, to: "GPL-3.0" }]);
  // Single line: no raw CR/LF/control survives to split the log or begin a command.
  assert.ok(!line.includes(nl));
  assert.ok(!line.includes(cr));
  assert.ok(!line.includes(del));
  // Content is collapsed to spaces, not dropped entirely — still legible.
  assert.ok(line.includes("foo MIT ::error::pwned x -> GPL-3.0"));
});

test("describeLicenseChanges caps an over-long license string", () => {
  const line = describeLicenseChanges([{ name: "foo", from: "A".repeat(200), to: "MIT" }]);
  assert.ok(line.includes("A".repeat(60)));
  assert.ok(!line.includes("A".repeat(61)));
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
