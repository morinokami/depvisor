import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPages } from "../src/core/pagination.ts";

test("collects every page until a short page", async () => {
  const pages: number[] = [];
  const result = await collectPages(
    async (page) => {
      pages.push(page);
      return page === 1 ? [1, 2] : [3];
    },
    { pageSize: 2, maxPages: 3, label: "items" },
  );
  assert.deepEqual(result, [1, 2, 3]);
  assert.deepEqual(pages, [1, 2]);
});

test("fails closed when the page limit is exhausted", async () => {
  await assert.rejects(
    collectPages(async () => [1, 2], { pageSize: 2, maxPages: 2, label: "items" }),
    /4-item limit/,
  );
});
