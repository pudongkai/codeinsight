export interface FakeLlmRequest {
  protocol: 'anthropic' | 'openai';
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  /** 收到请求的时间（毫秒） */
  at: number;
  /** 第几个请求，从 0 开始 */
  index: number;
  /** 回复写完之前客户端断开了连接 */
  aborted: boolean;
}

export interface FakeToolCall {
  id?: string;
  name: string;
  input?: unknown;
  /** 参数原文，给出时代替 input 的 JSON（模拟不完整的参数） */
  rawArgs?: string;
}

/** 正常回复：请求带 stream: true 时按协议流式返回，否则返回完整 JSON */
export interface FakeLlmSuccess {
  text?: string;
  toolCalls?: FakeToolCall[];
  /** 输出达到上限（anthropic max_tokens、openai length） */
  truncated?: boolean;
  headers?: Record<string, string>;
  /** 文字每个增量的字符数，默认 4 */
  deltaChars?: number;
  /** 工具调用一次给出完整参数（openai 为一片完整的 tool_calls） */
  wholeToolCalls?: boolean;
  /** 流按这么多字符重新切分写出（模拟跨 chunk 的半行） */
  chunkChars?: number;
  /** 每段之间等待的毫秒数 */
  delayMs?: number;
  /** 换行用 \r\n */
  crlf?: boolean;
  /** 开头加一行注释 */
  comments?: boolean;
  /** 写到结束标记之前就停住、不结束响应（测试中止） */
  hang?: boolean;
  /** openai 工具调用分片不带 index */
  noIndex?: boolean;
  /** openai 流里不给 usage */
  noUsage?: boolean;
  /** 不理会 stream: true，返回完整 JSON */
  json?: boolean;
}

/** 字符串为正常的文本回复 */
export type FakeLlmReply =
  | string
  | FakeLlmSuccess
  | { status: number; headers?: Record<string, string>; errorType?: string; body?: unknown };

export interface FakeLlmOptions {
  reply?: (req: FakeLlmRequest) => FakeLlmReply | Promise<FakeLlmReply>;
  script?: FakeLlmReply[];
}

export interface FakeLlm {
  url: string;
  requests: FakeLlmRequest[];
  setScript(next: FakeLlmReply[]): void;
  close(): Promise<void>;
}

export function startFakeLlm(opts?: FakeLlmOptions): Promise<FakeLlm>;

export function fakeLlmEnv(url: string, provider?: 'anthropic' | 'openai-compatible'): Record<string, string>;

export function lastUserText(req: FakeLlmRequest): string;

/** 第一条用户消息的文字（问答的问题） */
export function firstUserText(req: FakeLlmRequest): string;

/** 本次请求里所有工具结果的文字，按出现顺序 */
export function toolResults(req: FakeLlmRequest): string[];

/** 概览请求的输入（第一条用户消息里 `Input:` 下一行的 JSON）；不是概览请求时返回 undefined */
export function overviewInput(req: FakeLlmRequest): ({ task: string; module?: string; group?: string } & Record<string, unknown>) | undefined;

/** 概览三类请求的确定性回复：模块名 `模块-<id>`，功能名 `功能-<默认组名>`，系统简介标题 `系统简介` */
export function overviewReply(req: FakeLlmRequest): string;
