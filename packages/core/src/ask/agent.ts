import { effectiveSendSource, type CodeInsightConfig } from '../config/index.js';
import { chatWithLog, type ChatMessage, type ChatResult, type ToolCall } from '../llm/chat.js';
import { isCliClient, LlmError, ToolsUnsupportedError, type LlmClient } from '../llm/index.js';
import { llmClientFromConfig } from '../llm/setup.js';
import { log } from '../log.js';
import type { SnapshotRow } from '../model/types.js';
import type { OverviewReport } from '../overview/types.js';
import type { SymbolRef } from '../report/types.js';
import { symbolRef } from '../review/impact.js';
import type { DataDirLayout } from '../store/data-dir.js';
import type { ChatTurn } from '../store/chats.js';
import type { Store } from '../store/db.js';
import type {
  AskErrorCode, AskEvent, AskLimitReason, AskMessageMeta, AskStatus, AskToolCallRecord, AskUsage,
} from './events.js';
import { runCliAsk } from './cli-agent.js';
import { symbolLinkIds } from './links.js';
import {
  askSystemPrompt, initialMessages, LIMIT_EMPTY_ANSWER, LIMIT_PROMPT, TRUNCATED_ANSWER_NOTE, TRUNCATED_ARGS_PROMPT, trimHistory,
} from './prompt.js';
import { entriesOf, type AskToolContext } from './tool-context.js';
import { ASK_TOOLS, invalidArgsRun, runAskTool, TOOL_LIMIT_RESULT, truncateToolResult } from './tools.js';

/** 每轮的输出上限 */
export const ASK_MAX_TOKENS = 4096;
/** 整个问题的时间上限 */
export const ASK_TIMEOUT_MS = 5 * 60_000;

export interface AskOptions {
  repo: string;
  store: Store;
  layout: DataDirLayout;
  config: Pick<CodeInsightConfig, 'overview' | 'ask'>;
  /** 当前快照（调用方确认已就绪） */
  snapshot: SnapshotRow;
  /** 用 askClient 取得 */
  client: LlmClient;
  question: string;
  /** 本次不发送源码；配置里已关闭时不能用它打开 */
  noSource?: boolean;
  /** 给出时读这个会话的历史，并把问题和回答存进去 */
  sessionId?: number;
  signal?: AbortSignal;
  onEvent?: (e: AskEvent) => void;
  timeoutMs?: number;
  /** 问答工具 MCP 服务的启动命令（`codeinsight mcp --ask-tools`）；本机 CLI 问答必须有 */
  toolServer?: AskToolServer;
}

export interface AskToolServer {
  command: string;
  args: string[];
}

export interface AskResult {
  status: AskStatus;
  answer: string;
  meta: AskMessageMeta;
  /** 保存到会话时回答那条消息的 id */
  messageId?: number;
}

export type AskClientResult = { client: LlmClient } | { code: 'llm_not_configured'; message: string };

/** 问答用的客户端：没有配置 LLM、配置有误或客户端不支持 chat 时返回 llm_not_configured 和配置方法 */
export function askClient(config: Pick<CodeInsightConfig, 'llm' | 'llmProblem'>, opts: { client?: LlmClient } = {}): AskClientResult {
  const how = 'set CODEINSIGHT_LLM_PROVIDER (anthropic or openai-compatible), CODEINSIGHT_LLM_API_KEY and, for openai-compatible, CODEINSIGHT_LLM_MODEL / CODEINSIGHT_LLM_BASE_URL';
  const c = llmClientFromConfig(config, { ...opts, skipped: 'question answering unavailable' });
  if (!c) return { code: 'llm_not_configured', message: `question answering needs an LLM: ${how}` };
  if ('warning' in c) return { code: 'llm_not_configured', message: `${c.warning.message}; ${how}` };
  if (!c.client.chat && !isCliClient(c.client)) return { code: 'llm_not_configured', message: 'the configured LLM client does not support tool calling' };
  return { client: c.client };
}

export type LoopEnd = { status: 'done' | 'limited'; reason?: AskLimitReason } | { status: 'failed' | 'cancelled'; code: AskErrorCode; message: string };

/** API 工具循环和本机 CLI 问答共用的状态 */
export interface AskRun {
  opts: AskOptions;
  ctx: AskToolContext;
  system: string;
  /** 已按条数和字符数截过的历史 */
  history: ChatTurn[];
  signal: AbortSignal;
  userSignal?: AbortSignal;
  timeout: AbortSignal;
  answer: string;
  rounds: number;
  toolChars: number;
  toolCalls: AskToolCallRecord[];
  refs: Map<string, SymbolRef>;
  /** 任一轮没有 usage 时为 null */
  usage: AskUsage | null;
}

interface Run extends AskRun {
  messages: ChatMessage[];
  truncatedArgs: number;
}

export function emit(run: AskRun, e: AskEvent): void {
  run.opts.onEvent?.(e);
}

export function appendText(run: AskRun, delta: string): void {
  run.answer += delta;
  emit(run, { type: 'text', delta });
}

function addUsage(run: Run, r: ChatResult): void {
  if (!run.usage) return;
  if (!r.usage) run.usage = null;
  else run.usage = { inputTokens: run.usage.inputTokens + r.usage.inputTokens, outputTokens: run.usage.outputTokens + r.usage.outputTokens };
}

/** 一轮请求；文字增量作为 text 事件发出，新一轮的文字和上一轮的之间空一行 */
async function chatRound(run: Run, toolChoice: 'auto' | 'none'): Promise<ChatResult> {
  run.rounds++;
  let first = true;
  const onText = (delta: string) => {
    if (first && run.answer && !run.answer.endsWith('\n')) appendText(run, '\n\n');
    first = false;
    appendText(run, delta);
  };
  const r = await chatWithLog(run.opts.client, {
    system: run.system, messages: run.messages, tools: ASK_TOOLS, toolChoice, maxTokens: ASK_MAX_TOKENS, signal: run.signal, onText,
  }, { round: run.rounds });
  addUsage(run, r);
  return r;
}

function inputArgs(call: ToolCall): Record<string, unknown> {
  return call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? (call.input as Record<string, unknown>) : {};
}

/** 执行一个工具调用：发 tool / tool_done 事件，结果截断后计入累计字符数，收集出现的符号 */
async function executeCall(run: Run, call: ToolCall): Promise<{ id: string; content: string; isError?: boolean }> {
  const args = inputArgs(call);
  emit(run, { type: 'tool', name: call.name, args });
  const started = Date.now();
  const out = call.invalidArgs ? invalidArgsRun() : await runAskTool(run.ctx, call.name, call.input);
  const content = truncateToolResult(out.content);
  const ms = Date.now() - started;
  run.toolChars += content.length;
  for (const s of out.symbols) run.refs.set(s.id, symbolRef(s, out.entries));
  run.toolCalls.push({ name: call.name, args, resultChars: content.length, ms, ...(out.error ? { error: out.error } : {}) });
  emit(run, { type: 'tool_done', name: call.name, resultChars: content.length, ...(out.error ? { error: out.error } : {}) });
  log.info('ask_tool', { round: run.rounds, tool: call.name, args: JSON.stringify(args).slice(0, 200), resultChars: content.length, ms, error: out.error });
  return { id: call.id, content, ...(out.error ? { isError: true } : {}) };
}

/** 按顺序执行本轮的工具调用，把模型的这轮回复和工具结果追加到消息；参数被截断时追加提示 */
async function runToolCalls(run: Run, r: ChatResult): Promise<void> {
  if (r.text || r.toolCalls.length > 0) run.messages.push({ role: 'assistant', text: r.text, toolCalls: r.toolCalls });
  const results: { id: string; content: string; isError?: boolean }[] = [];
  let skipped = 0;
  for (const call of r.toolCalls) {
    run.signal.throwIfAborted();
    // 累计结果已超上限：剩下的调用不执行，但每个调用都要有结果（anthropic 要求 tool_use 都有对应的 tool_result）
    if (run.toolChars > run.opts.config.ask.maxToolChars) {
      results.push({ id: call.id, content: TOOL_LIMIT_RESULT, isError: true });
      skipped++;
    } else results.push(await executeCall(run, call));
  }
  if (skipped > 0) log.warn('ask_tool_calls_skipped', { round: run.rounds, skipped, toolChars: run.toolChars });
  if (results.length > 0) run.messages.push({ role: 'tool', results });
  if (r.incompleteToolCall) {
    log.warn('ask_tool_args_truncated', { round: run.rounds, streak: run.truncatedArgs });
    run.messages.push({ role: 'user', text: TRUNCATED_ARGS_PROMPT });
  }
}

function limitReason(run: Run): AskLimitReason | undefined {
  if (run.rounds >= run.opts.config.ask.maxRounds) return 'max_rounds';
  if (run.toolChars > run.opts.config.ask.maxToolChars) return 'max_tool_chars';
  return undefined;
}

/** 达到上限：禁止工具再请求一次；这一轮仍返回的工具调用丢弃，没有文字时给固定说明 */
async function finalRound(run: Run, reason: AskLimitReason): Promise<LoopEnd> {
  log.warn('ask_limit', { reason, rounds: run.rounds, toolChars: run.toolChars });
  run.messages.push({ role: 'user', text: LIMIT_PROMPT });
  const r = await chatRound(run, 'none');
  if (r.toolCalls.length > 0 || r.incompleteToolCall) log.warn('ask_final_tool_calls_dropped', { count: r.toolCalls.length });
  if (!r.text.trim()) appendText(run, `${run.answer ? '\n\n' : ''}${LIMIT_EMPTY_ANSWER}`);
  return { status: 'limited', reason };
}

/** 工具调用循环：直到模型不再调用工具、达到上限或出错 */
async function loop(run: Run): Promise<LoopEnd> {
  for (;;) {
    run.signal.throwIfAborted();
    const limit = limitReason(run);
    if (limit) return finalRound(run, limit);
    const r = await chatRound(run, 'auto');
    run.truncatedArgs = r.incompleteToolCall ? run.truncatedArgs + 1 : 0;
    if (run.truncatedArgs >= 2) {
      return { status: 'failed', code: 'llm_truncated', message: 'the model output was cut off inside tool arguments twice in a row' };
    }
    if (r.toolCalls.length === 0 && !r.incompleteToolCall) {
      if (r.stop !== 'max_tokens') return { status: 'done' };
      appendText(run, `\n\n${TRUNCATED_ANSWER_NOTE}`);
      return { status: 'limited', reason: 'max_tokens' };
    }
    await runToolCalls(run, r);
  }
}

/** 抛出的错误转成结束原因：用户中止、超时、模型不支持工具、请求失败、其他内部错误 */
export function failure(run: AskRun, err: unknown): LoopEnd {
  if (run.userSignal?.aborted) return { status: 'cancelled', code: 'cancelled', message: 'the question was cancelled' };
  if (run.timeout.aborted) return { status: 'failed', code: 'timeout', message: `no answer within ${Math.round((run.opts.timeoutMs ?? ASK_TIMEOUT_MS) / 1000)}s` };
  if (err instanceof ToolsUnsupportedError) return { status: 'failed', code: 'tools_unsupported', message: '当前模型不支持工具调用，请换用支持 function calling 的模型' };
  if (err instanceof LlmError) return { status: 'failed', code: 'llm_failed', message: `LLM request failed: ${err.message.split('\n')[0]}` };
  log.error('ask_internal_error', { error: (err as Error).message.split('\n')[0], stack: (err as Error).stack?.split('\n')[1]?.trim() });
  return { status: 'failed', code: 'internal_error', message: 'internal error while answering' };
}

/** 到当前快照查这些符号并加进 refs；已有的和查不到的跳过 */
export function addRefsByIds(run: AskRun, ids: string[]): void {
  const missing = [...new Set(ids)].filter((id) => !run.refs.has(id));
  if (missing.length === 0) return;
  const { store, snapshot } = run.ctx;
  const found = store.getSymbolsByIds(snapshot.id, missing);
  const entries = entriesOf(run.ctx, found.map((s) => s.id));
  for (const s of found) run.refs.set(s.id, symbolRef(s, entries));
}

/** 回答里 sym: 链接引用、但工具结果里没出现过的符号 */
function addLinkedRefs(run: AskRun): void {
  addRefsByIds(run, symbolLinkIds(run.answer));
}

function messageMeta(run: AskRun, end: LoopEnd): AskMessageMeta {
  return {
    status: end.status, ...('reason' in end && end.reason ? { reason: end.reason } : {}),
    contentKey: run.ctx.snapshot.contentKey, sendSource: run.ctx.sendSource, toolCalls: run.toolCalls,
    refs: Object.fromEntries(run.refs), ...(run.usage ? { usage: run.usage } : {}),
    ...('code' in end ? { error: { code: end.code, message: end.message } } : {}),
  };
}

/** 存回答；会话在回答过程中被删除（外键不存在）时只记日志 */
function saveAnswer(run: AskRun, meta: AskMessageMeta): number | undefined {
  const { sessionId } = run.opts;
  if (sessionId === undefined) return undefined;
  try {
    return run.ctx.store.chats.addMessage(sessionId, 'assistant', run.answer, meta);
  } catch (err) {
    log.warn('ask_message_not_saved', { sessionId, error: (err as Error).message.split('\n')[0] });
    return undefined;
  }
}

function finish(run: AskRun, end: LoopEnd, started: number): AskResult {
  addLinkedRefs(run);
  const meta = messageMeta(run, end);
  const messageId = saveAnswer(run, meta);
  const id = messageId !== undefined ? { messageId } : {};
  if ('code' in end) emit(run, { type: 'error', ...id, code: end.code, message: end.message });
  else emit(run, { type: 'done', ...id, status: end.status, ...(end.reason ? { reason: end.reason } : {}), refs: meta.refs, ...(meta.usage ? { usage: meta.usage } : {}) });
  const fields = { status: end.status, reason: 'reason' in end ? end.reason : undefined, code: 'code' in end ? end.code : undefined, rounds: run.rounds, toolCalls: run.toolCalls.length, toolChars: run.toolChars, chars: run.answer.length, refs: run.refs.size, ms: Date.now() - started };
  if (end.status === 'failed') log.warn('ask_failed', fields);
  else log.info('ask_done', fields);
  return { status: end.status, answer: run.answer, meta, ...id };
}

/** 快照对应的当前概览（问答的系统提示和 get_module 用），没有时为 undefined */
export function currentOverview(store: Store, snapshot: SnapshotRow): OverviewReport | undefined {
  return store.overviews.current(snapshot.kind).overview?.result ?? undefined;
}

/** 取发送源码设置、概览、历史，建超时信号和工具环境 */
function startRun(opts: AskOptions): AskRun {
  const { store, snapshot, config } = opts;
  const sendSource = effectiveSendSource(config, opts.noSource);
  const overview = currentOverview(store, snapshot);
  const history = opts.sessionId !== undefined ? trimHistory(store.chats.turns(opts.sessionId)) : [];
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? ASK_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const ctx: AskToolContext = { repo: opts.repo, store, layout: opts.layout, snapshot, sendSource, signal, ...(overview ? { overview } : {}) };
  return {
    opts, ctx, system: askSystemPrompt({ sendSource, ...(overview ? { overview } : {}) }), history,
    signal, ...(opts.signal ? { userSignal: opts.signal } : {}), timeout,
    answer: '', rounds: 0, toolChars: 0, toolCalls: [], refs: new Map(), usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** API 客户端的工具循环 */
async function runApiAsk(base: AskRun): Promise<LoopEnd> {
  const run: Run = Object.assign(base, { messages: initialMessages(base.history, base.opts.question), truncatedArgs: 0 });
  try {
    return await loop(run);
  } catch (err) {
    return failure(run, err);
  }
}

/**
 * 回答一个问题：带上系统提示（含当前概览）和会话历史，循环调用模型和只读工具，文字流式发出。
 * 达到轮数或工具结果上限时禁止工具再请求一次（limited）；失败、超时、中止都以事件和返回值告知，不抛出。
 * 给出 sessionId 时问题和回答（含已收到的部分）存进会话。
 */
export async function runAsk(opts: AskOptions): Promise<AskResult> {
  const started = Date.now();
  const run = startRun(opts);
  const userMessageId = opts.sessionId !== undefined ? opts.store.chats.addMessage(opts.sessionId, 'user', opts.question, null) : undefined;
  emit(run, { type: 'start', ...(userMessageId !== undefined ? { messageId: userMessageId } : {}) });
  log.info('ask_started', {
    provider: opts.client.provider, model: opts.client.model, sessionId: opts.sessionId, questionChars: opts.question.length,
    sendSource: run.ctx.sendSource, overview: run.ctx.overview !== undefined, historyTurns: run.history.length,
    maxRounds: opts.config.ask.maxRounds, maxToolChars: opts.config.ask.maxToolChars,
  });
  const end = isCliClient(opts.client) ? await runCliAsk(run, opts.client) : await runApiAsk(run);
  return finish(run, end, started);
}
