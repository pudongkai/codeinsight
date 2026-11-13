#!/usr/bin/env node
// 假的 opencode 命令：`run` 按 FAKE_CLI_SCENARIO 输出 `--format json` 的行（逗号分隔时第 n 次运行用第 n 项），
// `session delete <id>` 只记录（FAKE_OPENCODE_DELETE_FAIL=1 时以 1 退出）。每次运行追加一行 JSON 到 FAKE_CLI_RECORD，
// 内容同 fake-claude.mjs。问答场景（stream、steps-exhausted）输出 codeinsight_ 前缀的 tool_use 行，不启动 MCP 服务。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const recordFile = process.env.FAKE_CLI_RECORD;
const SESSION = process.env.FAKE_OPENCODE_SESSION ?? 'ses_fake123';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function runCount() {
  if (!recordFile || !existsSync(recordFile)) return 0;
  return readFileSync(recordFile, 'utf8').split('\n').filter((l) => l && JSON.parse(l).argv[0] === 'run').length;
}

function record(stdin, extra = {}) {
  if (!recordFile) return;
  const names = (process.env.FAKE_CLI_RECORD_ENV ?? '').split(',').filter(Boolean);
  const values = Object.fromEntries(names.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
  appendFileSync(recordFile, JSON.stringify({ argv: args, stdin, cwd: process.cwd(), pwd: process.env.PWD, envNames: Object.keys(process.env).sort(), env: values, ...extra }) + '\n');
}

const line = (type, o) => process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID: SESSION, ...o }) + '\n');
const stepStart = () => line('step_start', { part: { type: 'step-start' } });
const stepFinish = (reason = 'stop') => line('step_finish', { part: { type: 'step-finish', reason, cost: 0.002, tokens: { input: 20, output: 6, reasoning: 0, cache: { read: 3, write: 1 } } } });
const text = (t) => line('text', { part: { type: 'text', text: t } });
const toolUse = (tool, input, output) => line('tool_use', {
  part: { type: 'tool', tool: `codeinsight_${tool}`, callID: `call_${tool}`, state: { status: 'completed', input, output, time: { start: 1000, end: 1012 } } },
});

const scenarios = {
  'ok-text': () => { stepStart(); text(process.env.FAKE_CLI_TEXT ?? 'OK'); stepFinish(); },
  'ok-structured': () => { stepStart(); text(process.env.FAKE_CLI_JSON ?? '{"answer":"ok"}'); stepFinish(); },
  'auth-error': () => {
    line('error', { error: { type: 'provider.auth', message: 'Access to model denied.', status: 403 } });
    process.exitCode = 1;
  },
  'rate-limit-v1': () => {
    stepStart();
    line('error', { error: { name: 'APIError', data: { message: 'Too many requests', statusCode: 429, isRetryable: true } } });
    process.exitCode = 1;
  },
  'free-limit': () => {
    line('error', { error: { type: 'provider.free-limit', message: 'Free usage limit reached.', status: 429 } });
    process.exitCode = 1;
  },
  'context-overflow': () => { line('error', { error: { name: 'ContextOverflowError', data: { message: 'input too long' } } }); process.exitCode = 1; },
  truncated: () => { stepStart(); text('{"answer":'); stepFinish('length'); },
  'no-session-exit': () => { process.stderr.write('Error: unknown option --bogus\n'); process.exitCode = 2; },
  hang: () => { stepStart(); setInterval(() => undefined, 1000); },
  stream: () => {
    stepStart();
    text('先查一下。');
    toolUse('search_symbols', { query: 'refund' }, process.env.FAKE_CLI_TOOL_RESULT ?? 'no symbols found');
    toolUse('get_symbol', { id: 'nope' }, 'error: not_found: no symbol with this id');
    stepFinish('tool-calls');
    stepStart();
    text('退款由 refund 处理。');
    stepFinish();
  },
  'steps-error-tool': () => {
    stepStart();
    line('tool_use', { part: { type: 'tool', tool: 'codeinsight_search_symbols', callID: 'call_e', state: { status: 'error', input: { query: 'x' }, error: 'MCP error -32603: boom' } } });
    text('没查到。');
    stepFinish();
  },
  'steps-exhausted': () => {
    stepStart();
    toolUse('search_symbols', { query: 'refund' }, 'no symbols found');
    stepFinish('tool-calls');
  },
};

if (args[0] === '--version') {
  process.stdout.write('2.2.0\n');
} else if (args[0] === 'session' && args[1] === 'delete') {
  record('', { sessionDelete: args[2] });
  if (process.env.FAKE_OPENCODE_DELETE_FAIL === '1') {
    process.stderr.write(`Session not found: ${args[2]}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`Session ${args[2]} deleted\n`);
} else {
  const stdin = readStdin();
  const list = (process.env.FAKE_CLI_SCENARIO ?? 'ok-text').split(',');
  const name = list[Math.min(runCount(), list.length - 1)];
  record(stdin, { scenario: name });
  (scenarios[name] ?? scenarios['ok-text'])();
}
