import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReleaseAge,
  clampCandidate,
  describeReleaseAge,
  fetchPackument,
  parseMinReleaseAge,
  versionTimes,
  type Packument,
} from "../src/core/release-age.ts";
import type { Candidate } from "../src/core/types.ts";

const NOW = Date.parse("2026-07-06T00:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW - n * 86_400_000).toISOString();
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

function timesOf(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries).map(([v, days]) => [v, NOW - days * 86_400_000]));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route by URL prefix and record calls so tests can assert the fixed endpoint. */
function stubFetch(routes: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  const impl = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(u);
    for (const [key, make] of Object.entries(routes)) {
      if (u.startsWith(key)) return make();
    }
    return new Response("not found", { status: 404 });
  };
  return impl as typeof fetch;
}

test("parseMinReleaseAge defaults empty to 1 and accepts non-negative integers", () => {
  assert.equal(parseMinReleaseAge(""), 1);
  assert.equal(parseMinReleaseAge("   "), 1);
  assert.equal(parseMinReleaseAge("0"), 0); // explicit disable
  assert.equal(parseMinReleaseAge("1"), 1);
  assert.equal(parseMinReleaseAge("14"), 14);
  assert.equal(parseMinReleaseAge(" 3 "), 3);
});

test("parseMinReleaseAge rejects everything else (fail-fast)", () => {
  for (const raw of ["-1", "1.5", "abc", "2x", "1e3", "0.5"]) {
    assert.equal(parseMinReleaseAge(raw), null, `expected null for '${raw}'`);
  }
});

test("versionTimes intersects time with versions, dropping bookkeeping and unpublished entries", () => {
  const packument: Packument = {
    time: {
      created: daysAgo(400),
      modified: daysAgo(1),
      "1.0.0": daysAgo(300),
      "1.1.0": daysAgo(100), // unpublished: absent from versions below
      "1.2.0": daysAgo(10),
      "1.3.0": 12345 as unknown as string, // non-string time
      "1.4.0": "not-a-date",
      constructor: daysAgo(5), // prototype key must not leak through `in`
    },
    versions: { "1.0.0": {}, "1.2.0": {}, "1.3.0": {}, "1.4.0": {} },
  };
  const times = versionTimes(packument);
  assert.deepEqual([...times.keys()].sort(), ["1.0.0", "1.2.0"]);
});

test("versionTimes is empty when time or versions is missing", () => {
  assert.equal(versionTimes({ time: { "1.0.0": daysAgo(10) } }).size, 0);
  assert.equal(versionTimes({ versions: { "1.0.0": {} } }).size, 0);
  assert.equal(versionTimes({}).size, 0);
});

test("clampCandidate keeps a mature latest verbatim (>= boundary)", () => {
  const c = cand({ name: "a", current: "1.0.0", latest: "2.0.0" });
  // Exactly minDays old counts as mature.
  const exact = clampCandidate(c, 7, NOW, timesOf({ "2.0.0": 7 }));
  assert.deepEqual(exact, { action: "keep" });
  const younger = clampCandidate(c, 7, NOW, timesOf({ "2.0.0": 6.9 }));
  assert.notEqual(younger.action, "keep");
});

test("clampCandidate rounds an immature latest down to the newest mature stable version", () => {
  const c = cand({ name: "a", current: "1.0.0", latest: "2.0.0", updateType: "major" });
  const times = timesOf({ "1.4.0": 30, "1.5.0": 10, "1.5.1": 8, "2.0.0": 0.5 });
  const got = clampCandidate(c, 7, NOW, times);
  // Newest mature (1.5.1, not 1.5.0), and updateType is recomputed: the group
  // key (and so branch/PR identity) depends on it — major became minor here.
  assert.deepEqual(got, { action: "clamp", latest: "1.5.1", updateType: "minor" });
});

test("clampCandidate excludes when nothing newer than current has matured", () => {
  const c = cand({ name: "a", current: "1.5.0", latest: "2.0.0" });
  const times = timesOf({ "1.4.0": 30, "1.5.0": 20, "2.0.0": 1 });
  assert.deepEqual(clampCandidate(c, 7, NOW, times), { action: "exclude" });
});

test("clampCandidate never clamps past latest, even when the registry has newer versions", () => {
  // A dist-tag deliberately held back must stay the ceiling: the cooldown only
  // ever rounds DOWN from what collect proposed.
  const c = cand({ name: "a", current: "1.0.0", latest: "1.5.0" });
  const times = timesOf({ "1.4.0": 30, "1.5.0": 1, "2.0.0": 60 });
  assert.deepEqual(clampCandidate(c, 7, NOW, times), {
    action: "clamp",
    latest: "1.4.0",
    updateType: "minor",
  });
});

test("clampCandidate treats a version without a publish time as unprovably mature", () => {
  const c = cand({ name: "a", current: "1.0.0", latest: "2.0.0" });
  // latest has no time entry at all → cannot be proven mature → clamp.
  const times = timesOf({ "1.5.0": 10 });
  assert.deepEqual(clampCandidate(c, 7, NOW, times), {
    action: "clamp",
    latest: "1.5.0",
    updateType: "minor",
  });
});

test("clampCandidate passes a mature prerelease latest verbatim", () => {
  // The stable-only clamp set cannot order 2.0.0-rc.1 vs 2.0.0, so a
  // prerelease latest survives only via the exact-string maturity check.
  const c = cand({ name: "a", current: "1.0.0", latest: "2.0.0-rc.1", updateType: "major" });
  const times = timesOf({ "1.5.0": 30, "2.0.0-rc.1": 10 });
  assert.deepEqual(clampCandidate(c, 7, NOW, times), { action: "keep" });
});

test("clampCandidate rounds an immature prerelease latest to a mature stable version", () => {
  const c = cand({ name: "a", current: "1.0.0", latest: "2.0.0-rc.1", updateType: "major" });
  const times = timesOf({ "1.5.0": 30, "1.6.0-beta.1": 40, "2.0.0-rc.1": 1 });
  // 1.6.0-beta.1 is mature but prerelease — never in the clamp set.
  assert.deepEqual(clampCandidate(c, 7, NOW, times), {
    action: "clamp",
    latest: "1.5.0",
    updateType: "minor",
  });
});

test("applyReleaseAge fetches each packument once from the fixed endpoint and fills the cache", async () => {
  const calls: string[] = [];
  const packuments = new Map<string, Packument | null>();
  const fetchImpl = stubFetch(
    {
      "https://registry.npmjs.org/lru-cache": () =>
        jsonResponse({
          time: { created: daysAgo(500), "10.0.0": daysAgo(400), "11.0.0": daysAgo(30) },
          versions: { "10.0.0": {}, "11.0.0": {} },
          repository: { url: "git+https://github.com/isaacs/node-lru-cache.git" },
        }),
    },
    calls,
  );
  const candidates = [cand({ name: "lru-cache", current: "10.0.0", latest: "11.0.0" })];
  const result = await applyReleaseAge(candidates, 7, { fetch: fetchImpl, now: NOW, packuments });
  assert.deepEqual(calls, ["https://registry.npmjs.org/lru-cache"]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0]?.latest, "11.0.0");
  // The cache is filled for reuse (source-repo links read the same packument).
  assert.equal(packuments.size, 1);
  assert.ok(packuments.get("lru-cache")?.repository);

  // A second pass with the same cache performs no further fetches.
  const again = await applyReleaseAge(candidates, 7, { fetch: fetchImpl, now: NOW, packuments });
  assert.deepEqual(calls, ["https://registry.npmjs.org/lru-cache"]);
  assert.equal(again.kept.length, 1);
});

test("applyReleaseAge rewrites clamped candidates in place, in input order", async () => {
  const fetchImpl = stubFetch({
    "https://registry.npmjs.org/fresh": () =>
      jsonResponse({
        time: { "1.0.0": daysAgo(200), "1.2.0": daysAgo(30), "2.0.0": daysAgo(0.1) },
        versions: { "1.0.0": {}, "1.2.0": {}, "2.0.0": {} },
      }),
    "https://registry.npmjs.org/settled": () =>
      jsonResponse({
        time: { "3.0.0": daysAgo(100), "3.1.0": daysAgo(50) },
        versions: { "3.0.0": {}, "3.1.0": {} },
      }),
  });
  const result = await applyReleaseAge(
    [
      cand({ name: "fresh", current: "1.0.0", latest: "2.0.0", updateType: "major" }),
      cand({ name: "settled", current: "3.0.0", latest: "3.1.0", updateType: "minor" }),
    ],
    7,
    { fetch: fetchImpl, now: NOW },
  );
  assert.deepEqual(
    result.kept.map((c) => [c.name, c.latest, c.updateType]),
    [
      ["fresh", "1.2.0", "minor"], // clamped and reclassified
      ["settled", "3.1.0", "minor"],
    ],
  );
  assert.deepEqual(result.clamped, [{ name: "fresh", from: "2.0.0", to: "1.2.0" }]);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.unavailable.length, 0);
});

test("applyReleaseAge drops unverifiable candidates as unavailable (404 and network error alike)", async () => {
  const failing = (async () => {
    throw new Error("egress blocked");
  }) as unknown as typeof fetch;
  const netError = await applyReleaseAge([cand({ name: "foo" })], 7, {
    fetch: failing,
    now: NOW,
  });
  assert.equal(netError.kept.length, 0);
  assert.deepEqual(
    netError.unavailable.map((c) => c.name),
    ["foo"],
  );

  // 404 (≒ a private-registry package) is the same fail-closed drop; treating
  // it as "private, wave through" would be a fail-open hole.
  const notFound = await applyReleaseAge([cand({ name: "@acme/private" })], 7, {
    fetch: stubFetch({}),
    now: NOW,
  });
  assert.deepEqual(
    notFound.unavailable.map((c) => c.name),
    ["@acme/private"],
  );

  // A packument without usable publish times is just as unverifiable.
  const noTimes = await applyReleaseAge([cand({ name: "bar" })], 7, {
    fetch: stubFetch({
      "https://registry.npmjs.org/bar": () => jsonResponse({ versions: { "2.0.0": {} } }),
    }),
    now: NOW,
  });
  assert.deepEqual(
    noTimes.unavailable.map((c) => c.name),
    ["bar"],
  );
});

test("applyReleaseAge excludes candidates whose only newer versions are still ripening", async () => {
  const fetchImpl = stubFetch({
    "https://registry.npmjs.org/eager": () =>
      jsonResponse({
        time: { "1.0.0": daysAgo(300), "1.0.1": daysAgo(2) },
        versions: { "1.0.0": {}, "1.0.1": {} },
      }),
  });
  const result = await applyReleaseAge(
    [cand({ name: "eager", current: "1.0.0", latest: "1.0.1", updateType: "patch" })],
    7,
    { fetch: fetchImpl, now: NOW },
  );
  assert.equal(result.kept.length, 0);
  assert.deepEqual(
    result.excluded.map((c) => c.name),
    ["eager"],
  );
  assert.equal(result.unavailable.length, 0);
});

test("applyReleaseAge passes 'unknown'-typed candidates through without fetching", async () => {
  const calls: string[] = [];
  const result = await applyReleaseAge(
    [cand({ name: "weird", current: "MISSING", latest: "1.0.0", updateType: "unknown" })],
    7,
    { fetch: stubFetch({}, calls), now: NOW },
  );
  assert.equal(calls.length, 0);
  assert.equal(result.kept.length, 1);
});

test("applyReleaseAge with minDays 0 is a no-op that fetches nothing", async () => {
  const calls: string[] = [];
  const result = await applyReleaseAge([cand({ name: "a" }), cand({ name: "b" })], 0, {
    fetch: stubFetch({}, calls),
    now: NOW,
  });
  assert.equal(calls.length, 0);
  assert.equal(result.kept.length, 2);
});

test("fetchPackument refuses invalid names without fetching", async () => {
  const calls: string[] = [];
  assert.equal(await fetchPackument("../../etc/passwd", { fetch: stubFetch({}, calls) }), null);
  assert.equal(calls.length, 0);
});

test("describeReleaseAge reports clamps, hold-backs, and drops; silent when nothing happened", () => {
  assert.equal(
    describeReleaseAge(
      { kept: [cand({ name: "a" })], clamped: [], excluded: [], unavailable: [] },
      1,
    ),
    "",
  );
  const note = describeReleaseAge(
    {
      kept: [],
      clamped: [{ name: "fresh", from: "2.0.0", to: "1.2.0" }],
      excluded: [cand({ name: "eager", latest: "1.0.1" })],
      unavailable: [cand({ name: "@acme/private" })],
    },
    7,
  );
  assert.match(note, /minimum_release_age=7/);
  assert.match(note, /fresh to 1\.2\.0 \(latest 2\.0\.0 is too new\)/);
  assert.match(note, /held back eager 1\.0\.1/);
  assert.match(note, /dropped @acme\/private \(release age unverifiable\)/);
});
