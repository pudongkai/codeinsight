import type { IncomingMessage, ServerResponse } from 'node:http';

/** 路由里抛出，由服务统一转成 `{error, message}` 的 JSON 响应 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, { error: err.code, ...(err.message !== err.code ? { message: err.message } : {}), ...err.extra });
}

const MAX_BODY_BYTES = 1024 * 1024;

/** 读取 JSON 请求体；空请求体按 `{}` 处理，超过 1MB 或不是 JSON 对象时返回 4xx */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'invalid_json', 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

/** 解析可选的整数查询参数，超出范围或不是整数时返回 400 */
export function intParam(value: string | null, name: string, opts: { min: number; max: number; fallback?: number }): number | undefined {
  if (value === null || value === '') return opts.fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new HttpError(400, 'invalid_param', `${name} must be an integer between ${opts.min} and ${opts.max}`);
  }
  return n;
}
