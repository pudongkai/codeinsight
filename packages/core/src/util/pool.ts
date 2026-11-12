/**
 * 并发上限执行器：最多同时运行 limit 个 fn，结果按 items 的顺序返回。
 * fn 抛错时整体以第一个错误结束（已开始的任务不会被取消），调用方需要逐项容错时在 fn 里自行捕获。
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}
