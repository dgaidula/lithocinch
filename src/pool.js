// Tiny dependency-free concurrency limiter. Replaces 2.9's sleep(1000)-driven
// "process N then setTimeout then process N more" batching, which existed only
// to avoid running out of file handles when everything went through disk. With
// in-memory buffers we just cap how many images are in flight at once.

/**
 * Run `worker` over every item, at most `limit` concurrently. Resolves to an
 * array of per-item results in input order: `{ status, value }` on success or
 * `{ status:'rejected', reason, item }` on failure — failures never abort the run.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<{status:'fulfilled',value:R,item:T}|{status:'rejected',reason:any,item:T}>>}
 */
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      try {
        results[index] = { status: 'fulfilled', value: await worker(item, index), item };
      } catch (reason) {
        results[index] = { status: 'rejected', reason, item };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
