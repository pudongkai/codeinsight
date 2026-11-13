import { estimateTokens } from '../intent/summary.js';
import {
  ClaudeCodeClient, claudeArgs, claudeEnv, claudeUsage, classifyClaudeError, classifyOpencodeError, cliError, newOpencodeOutput, opencodeArgs, opencodeConfig,
  opencodeEnv, opencodeRunContext, opencodeUsage, parseClaudeLine, parseOpencodeLine, runCli, withCliTempDir, writeCliFile,
  type ClaudeOutput, type CliExit, type CliSpec, type CliUsage, type OpencodeClient, type OpencodeOutput,
} from '../llm/cli/index.js';
import { logCliExit, logCliFailure } from '../llm/cli/process.js';
import { LlmTruncatedError, type CliError } from '../llm/index.js';
import { log } from '../log.js';
import type { ChatTurn } from '../store/chats.js';
import { addRefsByIds, appendText, ASK_MAX_TOKENS, ASK_TIMEOUT_MS, emit, failure, type AskRun, type AskToolServer, type LoopEnd } from './agent.js';
import type { AskLimitReason, AskToolError, AskUsage } from './events.js';
import { LIMIT_EMPTY_ANSWER, TRUNCATED_ANSWER_NOTE } from './prompt.js';
import { ASK_TOOLS } from './tools.js';

/** 两次输出之间的最长间隔 */
export const CLI_ASK_IDLE_TIMEOUT_MS = 120_000;
/** MCP 服务名；Claude Code 的工具名前缀为 mcp__<名字>__，opencode 为 <名字>_ */
const MCP_NAME = 'codeinsight';
const CLAUDE_TOOL_PREFIX = `mcp__${MCP_NAME}__`;
const OPENCODE_TOOL_PREFIX = `${MCP_NAME}_`;

const CLI_NOTE = [
  `Only the tools from the "${MCP_NAME}" MCP server are available. Their names carry a prefix`,
  `(such as ${CLAUDE_TOOL_PREFIX} or ${OPENCODE_TOOL_PREFIX}) but they are the tools described above.`,
].join(' ');

const TOOL_ERRORS = new Set<AskToolError>(['not_found', 'path_not_allowed', 'file_changed', 'file_too_large', 'invalid_args', 'overview_missing', 'internal_error']);
/** 工具结果里符号行的开头（symbolLine 的格式 `<id> <kind> <qualifiedName> @ <path>:<line>`） */
const SYMBOL_LINE = /^\s*(\S+) \S+ \S+ @ \S+:\d/;

/** 历史按“用户：… / 回答：…”拼成文字放在当前问题前面；没有历史时只有问题 */
export function cliAskPrompt(history: ChatTurn[], question: string): string {
  if (history.length === 0) return question;
  const turns = history.map((t) => `用户：${t.question}\n回答：${t.answer}`).join('\n\n');
  return `之前的对话：\n\n${turns}\n\n当前问题：${question}`;
}

/** ask-tools 服务的参数：调用方给的命令加上仓库、数据目录、快照和上限 */
export function toolServerArgs(run: AskRun, server: AskToolServer): string[] {
  const { repo, layout, snapshot, config } = run.opts;
  return [
    ...server.args, '--repo', repo, '--data-dir', layout.root, '--snapshot', String(snapshot.id),
    ...(run.ctx.sendSource ? [] : ['--no-source']), '--max-tool-chars', String(config.ask.maxToolChars),
  ];
}

interface PendingTool {
  name: string;
  args: Record<string, unknown>;
  started: number;
}

interface StreamState {
  run: AskRun;
  prompt: string;
  /** 下一段文字属于新的一条消息：和已有文字之间空一行 */
  newMessage: boolean;
  /** 收到过逐字增量；没有时用 assistant 消息里的整段文字 */
  sawDelta: boolean;
  pending: Map<string, PendingTool>;
  /** 工具结果里出现的符号 id，结束时补查 refs */
  resultIds: string[];
  /** 工具服务没有连上时的状态（如 failed）；之后的输出不再处理 */
  toolServerProblem?: string;
  /** 发现工具服务没连上时结束子进程 */
  stop: AbortController;
}

function addText(st: StreamState, text: string): void {
  if (!text) return;
  if (st.newMessage && st.run.answer && !st.run.answer.endsWith('\n')) appendText(st.run, '\n\n');
  st.newMessage = false;
  appendText(st.run, text);
}

function objectArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function toolStarted(st: StreamState, id: string, rawName: string, input: unknown, prefix: string): PendingTool {
  const tool = { name: rawName.startsWith(prefix) ? rawName.slice(prefix.length) : rawName, args: objectArgs(input), started: Date.now() };
  st.pending.set(id, tool);
  st.newMessage = true;
  emit(st.run, { type: 'tool', name: tool.name, args: tool.args });
  return tool;
}

/**
 * 工具结果的错误码：去掉 CLI 可能加的外层包装（`<tool_use_error>` 标签、`Error: ` 前缀）后按 `error: <code>:` 匹配；
 * 认不出错误码但 CLI 标了出错时为 internal_error
 */
export function toolErrorOf(text: string, isError: boolean): AskToolError | undefined {
  const body = text.trim().replace(/^<tool_use_error>\s*/, '').replace(/\s*<\/tool_use_error>$/, '').replace(/^Error:\s*(?=error: )/, '');
  const code = /^error: ([a-z_]+):/.exec(body)?.[1] as AskToolError | undefined;
  if (code && TOOL_ERRORS.has(code)) return code;
  return isError ? 'internal_error' : undefined;
}

/** 工具结果：发 tool_done，记录调用和累计字符，收集结果里的符号 id */
function toolFinished(st: StreamState, tool: PendingTool, text: string, isError: boolean, ms = Date.now() - tool.started): void {
  const code = toolErrorOf(text, isError);
  const error = code ? { error: code } : {};
  const { run } = st;
  run.toolChars += text.length;
  run.toolCalls.push({ name: tool.name, args: tool.args, resultChars: text.length, ms, ...error });
  for (const line of text.split('\n')) {
    const id = SYMBOL_LINE.exec(line)?.[1];
    if (id) st.resultIds.push(id);
  }
  emit(run, { type: 'tool_done', name: tool.name, resultChars: text.length, ...error });
  log.info('ask_tool', { tool: tool.name, args: JSON.stringify(tool.args).slice(0, 200), resultChars: text.length, ms, error: error.error, toolChars: run.toolChars });
}

// ---------- 结束原因 ----------

function limitedEnd(run: AskRun, reason: AskLimitReason): LoopEnd {
  log.warn('ask_limit', { reason, rounds: run.rounds, toolChars: run.toolChars });
  if (!run.answer.trim()) appendText(run, LIMIT_EMPTY_ANSWER);
  return { status: 'limited', reason };
}

function truncatedEnd(run: AskRun): LoopEnd {
  appendText(run, `\n\n${TRUNCATED_ANSWER_NOTE}`);
  return limitedEnd(run, 'max_tokens');
}

function successEnd(run: AskRun): LoopEnd {
  if (run.toolChars > run.opts.config.ask.maxToolChars) return limitedEnd(run, 'max_tool_chars');
  return { status: 'done' };
}

/** 子进程因中止、超时或关闭结束：用户中止、整题超时按 failure 的顺序判断，CLI 自己的空闲超时记为 timeout */
function interruptedEnd(run: AskRun, spec: CliSpec, exit: CliExit): LoopEnd {
  if (run.userSignal?.aborted || run.timeout.aborted) return failure(run, new Error('aborted'));
  if (exit.killed) return { status: 'cancelled', code: 'cancelled', message: 'the question was cancelled because CodeInsight is shutting down' };
  if (exit.timedOut) return { status: 'failed', code: 'timeout', message: `no output from ${spec.provider} for ${Math.round(CLI_ASK_IDLE_TIMEOUT_MS / 1000)}s` };
  return failure(run, cliError(spec.provider, 'cancelled'));
}

function errorEnd(run: AskRun, spec: CliSpec, exit: CliExit, err: CliError | LlmTruncatedError): LoopEnd {
  if (err instanceof LlmTruncatedError) return truncatedEnd(run);
  logCliFailure(spec, err, exit);
  return failure(run, err);
}

// ---------- Claude Code ----------

interface ClaudeLine {
  type?: string;
  subtype?: string;
  mcp_servers?: { name?: string; status?: string }[];
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]).filter((b) => b && typeof b === 'object') : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * init 行里 codeinsight 服务不是 connected 时 CLI 不会报错，模型会不用工具直接回答，所以记下状态并结束子进程。
 * Claude Code 在输出 init 行之前会等 MCP 服务连上；等满它的启动时限仍没连上时报 pending，之后这一轮请求不带这些工具，
 * 所以 pending 和启动失败（failed，如快照已清理）一样处理
 */
function checkToolServer(st: StreamState, line: ClaudeLine): void {
  if (!Array.isArray(line.mcp_servers)) return;
  const status = line.mcp_servers.find((s) => s?.name === MCP_NAME)?.status ?? 'missing';
  if (status === 'connected') return;
  st.toolServerProblem = status;
  log.warn('ask_tool_server_not_connected', { status });
  st.stop.abort();
}

/** stream-json 的一行：逐字增量 → text；assistant 的 tool_use → tool；user 的 tool_result → tool_done */
function onClaudeLine(st: StreamState, out: ClaudeOutput, value: unknown): void {
  if (st.toolServerProblem) return;
  parseClaudeLine(out, value);
  const line = value as ClaudeLine | null;
  if (line?.type === 'system' && line.subtype === 'init') checkToolServer(st, line);
  else if (line?.type === 'stream_event') {
    if (line.event?.type === 'message_start') st.newMessage = true;
    else if (line.event?.type === 'content_block_delta' && line.event.delta?.type === 'text_delta') {
      st.sawDelta = true;
      addText(st, line.event.delta.text ?? '');
    }
  } else if (line?.type === 'assistant') {
    for (const b of blocksOf(line.message?.content)) {
      if (b.type === 'text' && !st.sawDelta) {
        st.newMessage = true;
        addText(st, b.text ?? '');
      } else if (b.type === 'tool_use' && b.id && b.name) toolStarted(st, b.id, b.name, b.input, CLAUDE_TOOL_PREFIX);
    }
  } else if (line?.type === 'user') {
    for (const b of blocksOf(line.message?.content)) {
      const tool = b.type === 'tool_result' && b.tool_use_id ? st.pending.get(b.tool_use_id) : undefined;
      if (!tool) continue;
      st.pending.delete(b.tool_use_id!);
      toolFinished(st, tool, resultText(b.content), b.is_error === true);
    }
  }
}

function claudeEnd(st: StreamState, out: ClaudeOutput, spec: CliSpec, exit: CliExit): LoopEnd {
  const { run } = st;
  const r = out.result;
  if (r?.num_turns !== undefined) run.rounds = r.num_turns;
  if (st.toolServerProblem) {
    const tip = st.toolServerProblem === 'pending' ? 'it did not finish starting in time; try again' : 'try again after the index is rebuilt';
    return { status: 'failed', code: 'internal_error', message: `the codeinsight tool service did not start (status: ${st.toolServerProblem}); ${tip}` };
  }
  if (exit.aborted || exit.timedOut || exit.killed) return interruptedEnd(run, spec, exit);
  if (r?.subtype === 'error_max_turns') return limitedEnd(run, 'max_rounds');
  const err = classifyClaudeError(out, exit, ASK_MAX_TOKENS);
  if (err) return errorEnd(run, spec, exit, err);
  if (!run.answer && r?.result) addText(st, r.result);
  return successEnd(run);
}

interface CliAskPlan {
  spec: CliSpec;
  onLine: (value: unknown) => void;
  usage: () => CliUsage;
  end: (exit: CliExit) => LoopEnd;
  /** 子进程结束后（成功、失败、中止都调用） */
  after?: () => void;
}

async function claudePlan(st: StreamState, client: ClaudeCodeClient, dir: string, server: AskToolServer): Promise<CliAskPlan> {
  const { run } = st;
  const systemFile = await writeCliFile(dir, 'system.md', `${run.system}\n\n${CLI_NOTE}`);
  const mcp = { mcpServers: { [MCP_NAME]: { type: 'stdio', command: server.command, args: toolServerArgs(run, server) } } };
  const mcpConfigFile = await writeCliFile(dir, 'mcp.json', JSON.stringify(mcp));
  const spec: CliSpec = {
    provider: 'claude-code', command: client.opts.command, mode: 'ask', model: client.model, cwd: dir, extraEnv: client.opts.extraEnv,
    args: claudeArgs({
      mode: 'ask', systemFile, mcpConfigFile, allowedTools: ASK_TOOLS.map((t) => `${CLAUDE_TOOL_PREFIX}${t.name}`),
      maxTurns: run.opts.config.ask.maxRounds + 1, model: client.model,
    }),
    env: claudeEnv(ASK_MAX_TOKENS), stdin: st.prompt,
  };
  const out: ClaudeOutput = {};
  return { spec, onLine: (v) => onClaudeLine(st, out, v), usage: () => claudeUsage(out.result), end: (exit) => claudeEnd(st, out, spec, exit) };
}

// ---------- opencode ----------

interface OpencodeToolLine {
  type?: string;
  part?: {
    text?: unknown;
    tool?: unknown;
    callID?: unknown;
    state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; time?: { start?: number; end?: number } };
  };
}

/** `--format json` 的一行：text 整段作为一次 text 事件；tool_use 已经带结果，同时发 tool 和 tool_done */
function onOpencodeLine(st: StreamState, out: OpencodeOutput, value: unknown): void {
  parseOpencodeLine(out, value);
  const line = value as OpencodeToolLine | null;
  if (line?.type === 'text' && typeof line.part?.text === 'string') {
    st.newMessage = true;
    addText(st, line.part.text);
  } else if (line?.type === 'tool_use' && typeof line.part?.tool === 'string') {
    const s = line.part.state ?? {};
    const id = typeof line.part.callID === 'string' ? line.part.callID : `call_${st.run.toolCalls.length}`;
    const tool = toolStarted(st, id, line.part.tool, s.input, OPENCODE_TOOL_PREFIX);
    st.pending.delete(id);
    const text = s.status === 'error' ? String(s.error ?? '') : typeof s.output === 'string' ? s.output : '';
    const ms = s.time?.start !== undefined && s.time.end !== undefined ? s.time.end - s.time.start : 0;
    toolFinished(st, tool, text, s.status === 'error', ms);
  }
}

/** 运行问题 → error 行、退出码、截断 → 步数用完（最后一步不是正常结束）→ 没有文字 → 成功 */
function opencodeEnd(st: StreamState, out: OpencodeOutput, spec: CliSpec, exit: CliExit): LoopEnd {
  const { run } = st;
  run.rounds = out.usage.steps;
  if (exit.aborted || exit.timedOut || exit.killed) return interruptedEnd(run, spec, exit);
  if (out.error || exit.exitCode !== 0 || out.lastReason === 'length') {
    return errorEnd(run, spec, exit, classifyOpencodeError(out, exit, ASK_MAX_TOKENS) ?? cliError('opencode', 'cli_failed'));
  }
  if (out.lastReason && out.lastReason !== 'stop') return limitedEnd(run, 'max_rounds');
  if (!run.answer.trim()) return errorEnd(run, spec, exit, cliError('opencode', 'bad_response', 'no text in the output'));
  return successEnd(run);
}

async function opencodePlan(st: StreamState, client: OpencodeClient, dir: string, server: AskToolServer): Promise<CliAskPlan> {
  const { run } = st;
  const o = client.opts;
  const { disabledMcp, deleteSessionLater } = opencodeRunContext(o);
  const systemFile = await writeCliFile(dir, 'system.md', `${run.system}\n\n${CLI_NOTE}`);
  const config = opencodeConfig({ systemFile, steps: run.opts.config.ask.maxRounds, mcpCommand: [server.command, ...toolServerArgs(run, server)], disabledMcp });
  const spec: CliSpec = {
    provider: 'opencode', command: o.command, mode: 'ask', model: client.model, cwd: dir, extraEnv: o.extraEnv,
    args: opencodeArgs(client.model), env: opencodeEnv(config), stdin: st.prompt,
  };
  const out = newOpencodeOutput();
  return {
    spec, onLine: (v) => onOpencodeLine(st, out, v), usage: () => opencodeUsage(out), end: (exit) => opencodeEnd(st, out, spec, exit),
    after: () => deleteSessionLater(out.sessionId),
  };
}

// ---------- 入口 ----------

/** CLI 返回了用量时用它，否则按字符数估算 */
function askUsage(st: StreamState, u: CliUsage): AskUsage {
  if (u.inputTokens !== undefined) {
    return { inputTokens: u.inputTokens, outputTokens: u.outputTokens ?? 0, ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}) };
  }
  return { inputTokens: estimateTokens(st.run.system + st.prompt), outputTokens: estimateTokens(st.run.answer), estimated: true };
}

async function runPlan(st: StreamState, client: ClaudeCodeClient | OpencodeClient, server: AskToolServer, dir: string): Promise<LoopEnd> {
  const { run } = st;
  const plan = client instanceof ClaudeCodeClient ? await claudePlan(st, client, dir, server) : await opencodePlan(st, client, dir, server);
  const exit = await runCli(plan.spec, {
    signal: AbortSignal.any([run.signal, st.stop.signal]), timeoutMs: run.opts.timeoutMs ?? ASK_TIMEOUT_MS, idleTimeoutMs: CLI_ASK_IDLE_TIMEOUT_MS,
    baseEnv: client.opts.baseEnv, onLine: plan.onLine,
  });
  const usage = plan.usage();
  logCliExit(plan.spec, exit, usage);
  plan.after?.();
  const end = plan.end(exit);
  run.usage = askUsage(st, usage);
  addRefsByIds(run, st.resultIds);
  log.info('ask_cli_end', { provider: plan.spec.provider, status: end.status, rounds: run.rounds, toolCalls: run.toolCalls.length, toolChars: run.toolChars, unfinishedTools: st.pending.size });
  return end;
}

/**
 * 用本机 CLI 回答：工具循环在 CLI 里进行，工具由 `codeinsight mcp --ask-tools` 服务提供（绑定当前快照）。
 * 输出逐行转成 text / tool / tool_done 事件；结束原因交给调用方的 finish 保存和发出。
 */
export async function runCliAsk(run: AskRun, client: ClaudeCodeClient | OpencodeClient): Promise<LoopEnd> {
  const server = run.opts.toolServer;
  if (!server) {
    log.error('ask_cli_no_tool_server', { provider: client.provider });
    return { status: 'failed', code: 'internal_error', message: 'internal error while answering' };
  }
  const st: StreamState = {
    run, prompt: cliAskPrompt(run.history, run.opts.question), newMessage: true, sawDelta: false, pending: new Map(), resultIds: [], stop: new AbortController(),
  };
  try {
    return await withCliTempDir((dir) => runPlan(st, client, server, dir));
  } catch (err) {
    return failure(run, err);
  }
}
