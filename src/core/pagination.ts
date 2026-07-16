/** Bounded pagination for GitHub list endpoints. */

export async function collectPages<T>(
  load: (page: number) => Promise<T[]>,
  options: { pageSize: number; maxPages: number; label: string },
): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= options.maxPages; page += 1) {
    const batch = await load(page);
    if (batch.length > options.pageSize) {
      throw new Error(`${options.label} returned an oversized page`);
    }
    result.push(...batch);
    if (batch.length < options.pageSize) return result;
  }
  throw new Error(
    `${options.label} exceeded the ${options.maxPages * options.pageSize}-item limit`,
  );
}
