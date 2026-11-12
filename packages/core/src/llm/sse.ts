/** 一条 SSE 事件：`event:` 行（没有时为 undefined）和 `data:` 行（多行用换行连接） */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * 增量 SSE 解析（anthropic、openai-compatible 共用）：按空行切事件，处理跨 chunk 的半行、
 * `\r\n` / `\r` 换行和 `:` 开头的注释行。
 */
export class SseParser {
  private buf = '';
  private event: string | undefined;
  private data: string[] = [];

  /** 喂入一段文本，返回其中已完整的事件 */
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      // 末尾单独的 \r 可能和下一段开头的 \n 是同一个换行，留到下一段再处理
      if (!m || (m[0] === '\r' && m.index === this.buf.length - 1)) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** 流结束：处理最后没有换行的一行和没有空行结尾的事件 */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    if (rest) {
      const ev = this.line(rest);
      if (ev) out.push(ev);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const ev = this.data.length > 0 ? { ...(this.event !== undefined ? { event: this.event } : {}), data: this.data.join('\n') } : undefined;
    this.event = undefined;
    this.data = [];
    return ev;
  }
}

/** 逐条读出响应体里的 SSE 事件；onChunk 在每收到一段数据时调用（空闲超时计时用） */
export async function* readSse(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    onChunk?.();
    yield* parser.push(decoder.decode(chunk, { stream: true }));
  }
  yield* parser.push(decoder.decode());
  yield* parser.end();
}
