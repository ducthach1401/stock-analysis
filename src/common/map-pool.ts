/**
 * Chạy tối đa `concurrency` tác vụ song song; kết quả cùng thứ tự `items`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const n = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = Array.from(
    { length: items.length },
    () => undefined as R,
  );
  let next = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: n }, () => runWorker()));
  return results;
}
