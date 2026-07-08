import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADVISORIES_UNAVAILABLE_NOTE,
  describeAdvisories,
  fetchAdvisories,
  prioritizeGroups,
  resolvesAdvisory,
  type OsvVuln,
} from "../src/core/advisories.ts";
import type { Candidate, Group } from "../src/core/types.ts";

test("ADVISORIES_UNAVAILABLE_NOTE stays actionable: names the endpoint to check", () => {
  // The run stays green on an OSV outage, so this note is the only user-visible
  // trace of the degradation — it must keep telling users what to verify.
  assert.match(ADVISORIES_UNAVAILABLE_NOTE, /api\.osv\.dev/);
  assert.match(ADVISORIES_UNAVAILABLE_NOTE, /[Ss]ecurity prioritization/);
});

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

/** An npm SEMVER advisory for `name`, introduced at 0, fixed at `fixed`. */
function semverVuln(id: string, name: string, event: Record<string, string>): OsvVuln {
  return {
    id,
    affected: [
      {
        package: { ecosystem: "npm", name },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, event] }],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stub the two OSV endpoints. `vulnsByPkg` maps a package name to the full vuln
 * list `/v1/query` returns; querybatch triage is derived from it (a package is
 * "vulnerable" iff it has any entry). Records call URLs for endpoint assertions.
 */
function osvStub(vulnsByPkg: Record<string, OsvVuln[]>, calls: string[] = []): typeof fetch {
  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(u);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.endsWith("/v1/querybatch")) {
      const queries = (body.queries ?? []) as { package: { name: string } }[];
      return jsonResponse({
        results: queries.map((q) => {
          const vulns = vulnsByPkg[q.package.name] ?? [];
          return vulns.length > 0 ? { vulns: vulns.map((v) => ({ id: v.id })) } : {};
        }),
      });
    }
    if (u.endsWith("/v1/query")) {
      const name = (body.package as { name: string }).name;
      return jsonResponse({ vulns: vulnsByPkg[name] ?? [] });
    }
    return new Response("not found", { status: 404 });
  };
  return impl as typeof fetch;
}

test("resolvesAdvisory is true when the fix version is at or below latest", () => {
  const v = semverVuln("GHSA-aaaa-bbbb-cccc", "lodash", { fixed: "4.17.21" });
  assert.equal(resolvesAdvisory("lodash", "4.17.15", "4.17.21", v), true);
  assert.equal(resolvesAdvisory("lodash", "4.17.15", "4.17.20", v), false); // fix not reached
});

test("resolvesAdvisory is false when the fix version does not exist yet (latest still affected)", () => {
  // lodash GHSA-f23m-r3pf-42rh: fixed 4.18.0, but latest published is 4.17.21.
  const v = semverVuln("GHSA-f23m-r3pf-42rh", "lodash", { fixed: "4.18.0" });
  assert.equal(resolvesAdvisory("lodash", "4.17.15", "4.17.21", v), false);
});

test("resolvesAdvisory handles last_affected ranges (no declared fix)", () => {
  const v: OsvVuln = {
    id: "GHSA-1111-2222-3333",
    affected: [
      {
        package: { ecosystem: "npm", name: "tar" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { last_affected: "4.5.0" }] }],
      },
    ],
  };
  assert.equal(resolvesAdvisory("tar", "4.4.0", "4.5.1", v), true); // past last_affected
  assert.equal(resolvesAdvisory("tar", "4.4.0", "4.5.0", v), false); // 4.5.0 is affected THROUGH
});

test("resolvesAdvisory only looks at npm affected entries for the exact package", () => {
  const v: OsvVuln = {
    id: "GHSA-4444-5555-6666",
    affected: [
      {
        package: { ecosystem: "PyPI", name: "lodash" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }],
      },
      {
        package: { ecosystem: "npm", name: "lodash-es" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.9.9" }] }],
      },
      {
        package: { ecosystem: "npm", name: "lodash" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
      },
    ],
  };
  // Resolves for lodash via its own entry; the PyPI/lodash-es entries are ignored.
  assert.equal(resolvesAdvisory("lodash", "4.17.15", "4.17.21", v), true);
});

test("resolvesAdvisory matches an explicit versions list", () => {
  const v: OsvVuln = {
    id: "GHSA-7777-8888-9999",
    affected: [{ package: { ecosystem: "npm", name: "foo" }, versions: ["1.0.0", "1.0.1"] }],
  };
  assert.equal(resolvesAdvisory("foo", "1.0.0", "1.0.2", v), true);
  assert.equal(resolvesAdvisory("foo", "1.0.0", "1.0.1", v), false); // target still listed
});

test("resolvesAdvisory refuses to promote on an unevaluable range (conservative)", () => {
  // ECOSYSTEM ranges are not orderable by core comparison → unknown → current is
  // not provably affected → no promotion, even though it might be vulnerable.
  const v: OsvVuln = {
    id: "GHSA-0000-0000-0000",
    affected: [
      {
        package: { ecosystem: "npm", name: "weird" },
        ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }],
      },
    ],
  };
  assert.equal(resolvesAdvisory("weird", "1.0.0", "2.0.0", v), false);
});

test("resolvesAdvisory handles disjoint introduced/fixed intervals in one range", () => {
  // Affected in [1.0.0, 1.5.0) and [2.0.0, 2.5.0); safe in between and after.
  const v: OsvVuln = {
    id: "GHSA-dddd-eeee-ffff",
    affected: [
      {
        package: { ecosystem: "npm", name: "multi" },
        ranges: [
          {
            type: "SEMVER",
            events: [
              { introduced: "1.0.0" },
              { fixed: "1.5.0" },
              { introduced: "2.0.0" },
              { fixed: "2.5.0" },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(resolvesAdvisory("multi", "2.1.0", "2.5.0", v), true); // out of second interval
  assert.equal(resolvesAdvisory("multi", "1.2.0", "1.7.0", v), true); // out of first interval
  assert.equal(resolvesAdvisory("multi", "2.1.0", "2.4.0", v), false); // still in second interval
});

test("prioritizeGroups stable-promotes resolving groups, keeping localeCompare order within a rank", () => {
  const g = (key: string, ...names: string[]): Group => ({
    key,
    reason: "",
    members: names.map((name) => cand({ name })),
  });
  // Input already in localeCompare order (as groupCandidates returns it).
  const groups = [
    g("dev/@types/node", "@types/node"),
    g("dev/eslint", "eslint"),
    g("prod/axios", "axios"),
    g("prod/lodash", "lodash"),
  ];
  const resolved = new Map([
    ["axios", ["GHSA-a"]],
    ["lodash", ["GHSA-b"]],
  ]);
  const ordered = prioritizeGroups(groups, resolved);
  assert.deepEqual(
    ordered.map((x) => x.key),
    // Promoted groups first, each rank keeping its original relative order.
    ["prod/axios", "prod/lodash", "dev/@types/node", "dev/eslint"],
  );
});

test("prioritizeGroups is a no-op when nothing resolves an advisory", () => {
  const g = (key: string): Group => ({ key, reason: "", members: [cand({ name: key })] });
  const groups = [g("a"), g("b"), g("c")];
  assert.deepEqual(
    prioritizeGroups(groups, new Map()).map((x) => x.key),
    ["a", "b", "c"],
  );
});

test("fetchAdvisories triages via querybatch then fetches only vulnerable packages in full", async () => {
  const calls: string[] = [];
  const fetchImpl = osvStub(
    {
      lodash: [semverVuln("GHSA-35jh-r3h4-6jhm", "lodash", { fixed: "4.17.21" })],
      // clean has no advisories → no /v1/query for it.
    },
    calls,
  );
  const result = await fetchAdvisories(
    [
      cand({ name: "lodash", current: "4.17.15", latest: "4.17.21" }),
      cand({ name: "clean", current: "1.0.0", latest: "2.0.0" }),
    ],
    { fetch: fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.deepEqual([...result.resolvedByPackage.entries()], [["lodash", ["GHSA-35jh-r3h4-6jhm"]]]);
  // Exactly one querybatch (triage) + one query (only the vulnerable package).
  assert.equal(calls.filter((u) => u.endsWith("/v1/querybatch")).length, 1);
  const queries = calls.filter((u) => u.endsWith("/v1/query"));
  assert.equal(queries.length, 1);
});

test("fetchAdvisories does not promote a package whose latest is still affected", async () => {
  const fetchImpl = osvStub({
    lodash: [
      semverVuln("GHSA-35jh-r3h4-6jhm", "lodash", { fixed: "4.17.21" }), // resolved
      semverVuln("GHSA-f23m-r3pf-42rh", "lodash", { fixed: "4.18.0" }), // still affects 4.17.21
    ],
  });
  const result = await fetchAdvisories(
    [cand({ name: "lodash", current: "4.17.15", latest: "4.17.21" })],
    {
      fetch: fetchImpl,
    },
  );
  assert.deepEqual([...(result.resolvedByPackage.get("lodash") ?? [])], ["GHSA-35jh-r3h4-6jhm"]);
});

test("fetchAdvisories counts an advisory by its GHSA alias when the primary id is not GHSA", async () => {
  // OSV may key a record by CVE and alias the GHSA. The GHSA is what promotes and
  // what the PR body links.
  const cveKeyed: OsvVuln = {
    id: "CVE-2021-23337",
    aliases: ["GHSA-35jh-r3h4-6jhm"],
    affected: [
      {
        package: { ecosystem: "npm", name: "lodash" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
      },
    ],
  };
  const result = await fetchAdvisories(
    [cand({ name: "lodash", current: "4.17.15", latest: "4.17.21" })],
    { fetch: osvStub({ lodash: [cveKeyed] }) },
  );
  assert.deepEqual([...(result.resolvedByPackage.get("lodash") ?? [])], ["GHSA-35jh-r3h4-6jhm"]);
});

test("fetchAdvisories does not promote an advisory with no GHSA (nothing the PR could link)", async () => {
  const noGhsa: OsvVuln = {
    id: "CVE-2021-23337", // no GHSA in id or aliases
    affected: [
      {
        package: { ecosystem: "npm", name: "lodash" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
      },
    ],
  };
  const result = await fetchAdvisories(
    [cand({ name: "lodash", current: "4.17.15", latest: "4.17.21" })],
    { fetch: osvStub({ lodash: [noGhsa] }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.resolvedByPackage.has("lodash"), false);
});

test("fetchAdvisories checks every workspace current, not just the merged lowest", async () => {
  // foo is at 1.0.0 in one workspace and 2.1.0 in another (merged current = the
  // lowest, 1.0.0). The advisory affects [2.0.0, 2.2.0): the 1.0.0 workspace is
  // clean, but the 2.1.0 one is vulnerable and updating to 2.2.0 resolves it.
  // Probing only the lowest 1.0.0 would miss this entirely.
  const vuln: OsvVuln = {
    id: "GHSA-aaaa-bbbb-cccc",
    affected: [
      {
        package: { ecosystem: "npm", name: "foo" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "2.0.0" }, { fixed: "2.2.0" }] }],
      },
    ],
  };
  const affected = (version: string): boolean => version === "2.1.0"; // only this current is in range
  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.endsWith("/v1/querybatch")) {
      const queries = (body.queries ?? []) as { version: string }[];
      return jsonResponse({
        results: queries.map((q) => (affected(q.version) ? { vulns: [{ id: vuln.id }] } : {})),
      });
    }
    const version = (body as { version: string }).version;
    return jsonResponse({ vulns: affected(version) ? [vuln] : [] });
  };
  const result = await fetchAdvisories(
    [cand({ name: "foo", current: "1.0.0", latest: "2.2.0", currents: ["1.0.0", "2.1.0"] })],
    { fetch: impl as typeof fetch },
  );
  assert.deepEqual([...(result.resolvedByPackage.get("foo") ?? [])], ["GHSA-aaaa-bbbb-cccc"]);
});

test("fetchAdvisories is fail-soft: a querybatch failure yields ok:false and neutral order", async () => {
  const failing = (async () => {
    throw new Error("egress blocked");
  }) as unknown as typeof fetch;
  const result = await fetchAdvisories([cand({ name: "lodash" })], { fetch: failing });
  assert.equal(result.ok, false);
  assert.equal(result.resolvedByPackage.size, 0);
});

test("fetchAdvisories bails to ok:false when querybatch results violate the contract", async () => {
  // A results array shorter than the probes (or with a non-object element) is an
  // API-contract drift; treating the gap as "clean" would silently order on a
  // partial snapshot, so fall back to the neutral order instead.
  const shortResults = (async () => jsonResponse({ results: [] })) as unknown as typeof fetch; // 0 results for 2 probes
  const short = await fetchAdvisories([cand({ name: "a" }), cand({ name: "b" })], {
    fetch: shortResults,
  });
  assert.equal(short.ok, false);
  assert.equal(short.resolvedByPackage.size, 0);

  const badElement = (async () => jsonResponse({ results: [null] })) as unknown as typeof fetch; // element not an object
  const bad = await fetchAdvisories([cand({ name: "a" })], { fetch: badElement });
  assert.equal(bad.ok, false);
  assert.equal(bad.resolvedByPackage.size, 0);
});

test("fetchAdvisories fails soft to ok:false + empty map when a flagged package's full query fails", async () => {
  // querybatch flags both as vulnerable, but /v1/query for `flaky` 500s. Ordering
  // on a partial OSV snapshot is worse than the neutral order — bail entirely so
  // the workflow logs it and falls back, rather than silently mis-ranking slots.
  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.endsWith("/v1/querybatch")) {
      const queries = (body.queries ?? []) as { package: { name: string } }[];
      return jsonResponse({ results: queries.map(() => ({ vulns: [{ id: "x" }] })) });
    }
    const name = (body.package as { name: string }).name;
    if (name === "flaky") return new Response("boom", { status: 500 });
    return jsonResponse({ vulns: [semverVuln("GHSA-aaaa-bbbb-cccc", name, { fixed: "1.5.0" })] });
  };
  const result = await fetchAdvisories(
    [
      cand({ name: "flaky", current: "1.0.0", latest: "1.5.0" }),
      cand({ name: "solid", current: "1.0.0", latest: "1.5.0" }),
    ],
    { fetch: impl as typeof fetch },
  );
  assert.equal(result.ok, false);
  assert.equal(result.resolvedByPackage.size, 0);
});

test("fetchAdvisories skips 'unknown'-typed candidates entirely (no fetch)", async () => {
  const calls: string[] = [];
  const result = await fetchAdvisories(
    [cand({ name: "weird", current: "MISSING", latest: "1.0.0", updateType: "unknown" })],
    { fetch: osvStub({}, calls) },
  );
  assert.equal(calls.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.resolvedByPackage.size, 0);
});

test("describeAdvisories lists prioritized packages; silent when nothing was prioritized", () => {
  assert.equal(describeAdvisories(new Map()), "");
  const note = describeAdvisories(
    new Map([
      ["lodash", ["GHSA-b", "GHSA-a"]],
      ["axios", ["GHSA-c"]],
    ]),
  );
  assert.match(note, /prioritized 2 updates/);
  assert.match(note, /axios \(GHSA-c\)/);
  assert.match(note, /lodash \(GHSA-b, GHSA-a\)/);
});
