import { parseArgs } from 'node:util';
import { askClient, buildSnapshot, effectiveSendSource, isQuestionTooLong, MAX_QUESTION_CHARS, notifyLlmOnce, ReviewArgsError, runAsk } from '@codeinsight/core';
import type { AskEvent } from '@codeinsight/core';
import { openWorkspace } from './workspace.js';

export const ASK_USAGE = `Usage: codeinsight ask "<question>" [--repo .] [--data-dir DIR] [--no-source]

Answer a question about the code in the working tree. The LLM looks things up with read-only tools
(search symbols, call graph, read source, grep). The answer is streamed to stdout, tool calls to stderr.
The session is not saved. Needs an LLM (CODEINSIGHT_LLM_PROVIDER).
--no-source  do not send code to the LLM: only signatures and locations
Exit codes: 0 answered (possibly cut short by a limit); 1 bad arguments, no LLM configured, or the answer failed.
`;

function parseAskArgs(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string', default: '.' },
      'data-dir': { type: 'string' },
      'no-source': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  const question = positionals.join(' ').trim();
  if (!values.help && !question) throw new ReviewArgsError('a question is required');
  if (isQuestionTooLong(question)) throw new ReviewArgsError(`the question is too long (at most ${MAX_QUESTION_CHARS} characters)`);
  return { ...values, question };
}

/** 工具调用的参数写成一行，长值截断 */
function argsText(args: Record<string, unknown>): string {
  return Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`).join(' ');
}

const LIMIT_TEXT: Record<string, string> = {
  max_rounds: 'the tool-call round limit (ask.maxRounds) was reached',
  max_tool_chars: 'the tool result limit (ask.maxToolChars) was reached',
  max_tokens: 'the answer hit the output length limit',
};

/** 文字写 stdout，工具调用进度和结束状态写 stderr；failed() 表示回答以错误结束 */
function eventPrinter(): { onEvent: (e: AskEvent) => void; failed: () => boolean } {
  let lastChar = '\n';
  let failed = false;
  const endLine = () => {
    if (lastChar !== '\n') process.stdout.write('\n');
    lastChar = '\n';
  };
  const onEvent = (e: AskEvent) => {
    if (e.type === 'text') {
      process.stdout.write(e.delta);
      if (e.delta) lastChar = e.delta.slice(-1);
    } else if (e.type === 'tool') process.stderr.write(`  [tool] ${e.name} ${argsText(e.args)}\n`);
    else if (e.type === 'tool_done' && e.error) process.stderr.write(`  [tool] ${e.name} failed: ${e.error}\n`);
    else if (e.type === 'done') {
      endLine();
      if (e.status === 'limited' && e.reason) process.stderr.write(`codeinsight: answer limited: ${LIMIT_TEXT[e.reason]}\n`);
    } else if (e.type === 'error') {
      endLine();
      failed = true;
      process.stderr.write(`error: ${e.message} (${e.code})\n`);
    }
  };
  return { onEvent, failed: () => failed };
}

/** codeinsight ask：用工作区快照回答一个问题，不保存会话 */
export async function runAskCommand(argv: string[]): Promise<number> {
  const args = parseAskArgs(argv);
  if (args.help) {
    process.stdout.write(ASK_USAGE);
    return 0;
  }
  const { repo, config, layout, store } = await openWorkspace(args.repo, args['data-dir']);
  try {
    const c = askClient(config);
    if ('code' in c) {
      process.stderr.write(`error: ${c.message}\n`);
      return 1;
    }
    const { snapshot } = await buildSnapshot({ repo, store, layout, config });
    const sendSource = effectiveSendSource(config, args['no-source']);
    const what = sendSource ? 'the question and related code' : 'the question and function signatures and locations (no code bodies)';
    notifyLlmOnce(c.client, `codeinsight: sending ${what} to ${c.client.provider} (${c.client.model})\n`, (m) => process.stderr.write(m));
    const printer = eventPrinter();
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once('SIGINT', onSigint);
    try {
      await runAsk({ repo, store, layout, config, snapshot, client: c.client, question: args.question, noSource: args['no-source'], signal: ac.signal, onEvent: printer.onEvent });
    } finally {
      process.off('SIGINT', onSigint);
    }
    return printer.failed() ? 1 : 0;
  } finally {
    store.close();
  }
}
