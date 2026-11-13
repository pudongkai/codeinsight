#!/usr/bin/env node
// 假的 claude 命令：按 FAKE_CLI_SCENARIO 输出预设内容。FAKE_CLI_SCENARIO 可以是逗号分隔的列表，
// 第 n 次运行用第 n 项（超出时用最后一项），次数按 FAKE_CLI_RECORD 里已有的行数算。
// 每次运行把 pid、argv、stdin、cwd、PWD、环境变量名、FAKE_CLI_RECORD_ENV 列出的变量值、系统提示文件的权限和内容、
// MCP 配置文件的权限和内容追加一行 JSON 到 FAKE_CLI_RECORD。
// 问答场景（stream、stream-no-partial、stream-then-hang）按 stream-json 格式输出文字增量、工具调用和工具结果，
// 不启动 MCP 服务；工具结果文字取 FAKE_CLI_TOOL_RESULT，FAKE_CLI_NO_USAGE=1 时 result 行不带用量，
// FAKE_CLI_TOOL_STRING=1 时 tool_result 的 content 是字符串（Claude Code 对 MCP 工具结果的实际格式）。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const recordFile = process.env.FAKE_CLI_RECORD;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function runIndex() {
  if (!recordFile || !existsSync(recordFile)) return 0;
  return readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).length;
}

function systemFile() {
  const i = args.indexOf('--system-prompt-file');
  if (i < 0) return undefined;
  const file = args[i + 1];
  return { mode: (statSync(file).mode & 0o777).toString(8), content: readFileSync(file, 'utf8') };
}

function mcpConfig() {
  const i = args.indexOf('--mcp-config');
  if (i < 0) return undefined;
  const file = args[i + 1];
  return { mode: (statSync(file).mode & 0o777).toString(8), content: JSON.parse(readFileSync(file, 'utf8')) };
}

function record(stdin, extra = {}) {
  if (!recordFile) return;
  const names = (process.env.FAKE_CLI_RECORD_ENV ?? '').split(',').filter(Boolean);
  const values = Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
  const entry = { pid: process.pid, argv: args, stdin, mcp: mcpConfig(), cwd: process.cwd(), pwd: process.env.PWD, envNames: Object.keys(process.env).sort(), env: values, system: systemFile(), ...extra };
  appendFileSync(recordFile, JSON.stringify(entry) + '\n');
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const stream = args.includes('stream-json');
const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 7 };
const result = (o) => out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.001, usage, ...o });
// 问答时 codeinsight 服务的状态取 FAKE_CLI_MCP_STATUS（默认 connected）
const init = () => stream && out({ type: 'system', subtype: 'init', model: 'claude-fake-1', tools: [], mcp_servers: [{ name: 'codeinsight', status: process.env.FAKE_CLI_MCP_STATUS ?? 'connected' }] });
const assistantError = (error, text) => stream && out({ type: 'assistant', error, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const hang = () => setInterval(() => undefined, 1000);

// ---------- 问答（stream-json） ----------
const PREFIX = 'mcp__codeinsight__';
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const messageStart = () => out({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } });
const assistant = (content) => out({ type: 'assistant', message: { role: 'assistant', content } });
const toolResult = (id, text, isError = false) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: process.env.FAKE_CLI_TOOL_STRING ? text : [{ type: 'text', text }], is_error: isError }] } });

/** 一条消息：partial 时先发增量再发整条 assistant，否则只发 assistant */
function message(partial, text, tools = []) {
  if (partial) {
    messageStart();
    for (const piece of text.match(/.{1,4}/gsu) ?? []) delta(piece);
  }
  if (text) assistant([{ type: 'text', text }]);
  for (const t of tools) assistant([{ type: 'tool_use', id: t.id, name: PREFIX + t.name, input: t.input }]);
}

function askStream(partial) {
  init();
  message(partial, '先查一下。', [{ id: 'tu_1', name: 'search_symbols', input: { query: 'refund' } }, { id: 'tu_2', name: 'get_symbol', input: { id: 'nope' } }]);
  toolResult('tu_1', process.env.FAKE_CLI_TOOL_RESULT ?? 'no symbols found');
  toolResult('tu_2', process.env.FAKE_CLI_TOOL_ERROR ?? 'error: not_found: no symbol with this id', true);
  message(partial, '退款由 refund 处理。');
  result({ result: '退款由 refund 处理。', num_turns: 2, ...(process.env.FAKE_CLI_NO_USAGE === '1' ? { usage: undefined, total_cost_usd: undefined } : {}) });
}

const scenarios = {
  'ok-text': () => { init(); result({ result: process.env.FAKE_CLI_TEXT ?? 'OK' }); },
  'ok-structured': () => {
    const value = JSON.parse(process.env.FAKE_CLI_JSON ?? '{"answer":"ok"}');
    init();
    result({ result: JSON.stringify(value), structured_output: value, num_turns: 2 });
  },
  // 按 stdin 里概览请求的 task 返回合格的结构化输出
  overview: (stdin) => {
    const task = /"task":"(\w+)"/.exec(stdin)?.[1];
    const value = task === 'module_summary' ? { name: '模块', responsibility: '负责', interfaces: [], models: [] }
      : task === 'feature_naming' ? { features: [] } : { title: '系统', summary: '简介' };
    init();
    result({ result: JSON.stringify(value), structured_output: value, num_turns: 2 });
  },
  'not-logged-in': () => {
    init();
    assistantError('authentication_failed', 'Not logged in · Please run /login');
    result({ is_error: true, result: 'Not logged in · Please run /login', terminal_reason: 'api_error', usage: undefined });
    process.exitCode = 1;
  },
  billing: () => {
    init();
    assistantError('billing_error', 'Credit balance is too low');
    result({ is_error: true, result: 'Credit balance is too low', api_error_status: 400 });
    process.exitCode = 1;
  },
  'rate-limit': () => {
    init();
    assistantError('rate_limit', 'API Error: Rate limited');
    result({ is_error: true, result: 'API Error: Rate limited', api_error_status: 429 });
    process.exitCode = 1;
  },
  overloaded: () => {
    init();
    assistantError('overloaded', 'API Error: Overloaded');
    result({ is_error: true, result: 'API Error: Overloaded', api_error_status: 529 });
    process.exitCode = 1;
  },
  truncated: () => { init(); result({ result: '{"answer":', stop_reason: 'max_tokens' }); },
  'max-turns': () => {
    init();
    result({ subtype: 'error_max_turns', is_error: true, result: undefined, errors: ['Reached maximum number of turns (3)'], terminal_reason: 'max_turns' });
    process.exitCode = 1;
  },
  'schema-retries': () => { init(); result({ subtype: 'error_max_structured_output_retries', is_error: true, result: undefined }); process.exitCode = 1; },
  'bad-json': () => { process.stdout.write('this is not json\n'); },
  'exit-2-stderr': () => {
    process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
    process.exitCode = 2;
  },
  hang,
  'slow-then-hang': () => { out({ type: 'system', subtype: 'init', model: 'claude-fake-1' }); hang(); },
  stream: () => askStream(true),
  'stream-no-partial': () => askStream(false),
  'stream-then-hang': () => { init(); message(true, '已经收到的部分'); hang(); },
  'spawn-grandchild': () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    record('', { grandchildPid: child.pid, note: 'grandchild' });
    hang();
  },
};

if (args[0] === '--version') {
  process.stdout.write('2.1.318 (Claude Code)\n');
} else if (args[0] === 'auth') {
  const loggedIn = !(process.env.FAKE_CLI_SCENARIO ?? '').startsWith('not-logged-in');
  out({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' });
  if (!loggedIn) process.exitCode = 1;
} else {
  const stdin = readStdin();
  const list = (process.env.FAKE_CLI_SCENARIO ?? 'ok-text').split(',');
  const name = list[Math.min(runIndex(), list.length - 1)];
  record(stdin, { scenario: name });
  (scenarios[name] ?? scenarios['ok-text'])(stdin);
}
