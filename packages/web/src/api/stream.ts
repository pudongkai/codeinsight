/** 响应里有一行不是合法 JSON（被截断或不是 NDJSON） */
export class NdjsonParseError extends Error {}

/**
 * 流式 NDJSON 读取：每行一个 JSON，读到一行就回调一次。
 * 浏览器不支持读取响应流（没有 body.getReader）时退回为等响应结束后一次处理全部行。
 * 出错（解析失败或回调抛错）时取消读取，让服务端知道连接已不再使用。
 */
export async function readNdjson<T>(res: Response, onItem: (item: T) => void): Promise<void> {
  const reader = res.body?.getReader?.();
  if (!reader) return emitLines((await res.text()).split('\n'), onItem);
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      emitLines(lines, onItem);
    }
    emitLines([pending + decoder.decode()], onItem);
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
}

/** 空行跳过 */
function emitLines<T>(lines: string[], onItem: (item: T) => void): void {
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    let item: T;
    try {
      item = JSON.parse(t) as T;
    } catch {
      throw new NdjsonParseError(`不是合法的 JSON：${t.slice(0, 80)}`);
    }
    onItem(item);
  }
}
