import type { CliLlmProvider } from '../../settings/types.js';
import { CliError, type CliErrorKind } from '../index.js';
import type { CliExit } from './process.js';

/** 能对应到 HTTP 状态的分类：askJson 对 429 / 5xx 等待后重试，对未登录、额度用完不重试 */
const KIND_STATUS: Partial<Record<CliErrorKind, number>> = {
  not_logged_in: 401, quota: 402, rate_limited: 429, server_error: 503, model_not_found: 404, invalid_request: 400,
};

const LOGIN_HINT: Record<CliLlmProvider, string> = {
  'claude-code': 'run `claude` in a terminal to log in',
  opencode: 'run `opencode auth login` in a terminal',
};

/** 每类错误附带的处理提示 */
function hint(provider: CliLlmProvider, kind: CliErrorKind): string | undefined {
  switch (kind) {
    case 'command_not_found':
    case 'not_executable':
      return 'set the command path in settings or CODEINSIGHT_LLM_COMMAND';
    case 'not_logged_in': return LOGIN_HINT[provider];
    case 'quota': return 'the account has no usage left';
    case 'rate_limited': return 'rate limited, try again later';
    case 'server_error': return 'the model service is busy';
    case 'model_not_found':
    case 'invalid_request':
      return 'check the model name';
    case 'context_overflow': return 'the input is too long for the model';
    case 'cli_failed': return 'upgrade the CLI or report the problem if it persists';
    default: return undefined;
  }
}

/** 按分类建 CliError；message 只带 CLI 的错误摘要，不带 prompt */
export function cliError(provider: CliLlmProvider, kind: CliErrorKind, detail?: string): CliError {
  const tip = hint(provider, kind);
  const d = detail?.trim();
  const text = `${provider} ${kind.replace(/_/g, ' ')}${d ? `: ${d}` : ''}${tip ? `; ${tip}` : ''}`;
  return new CliError(kind, text, KIND_STATUS[kind]);
}

/** HTTP 状态码对应的分类；不认识的返回 undefined */
export function kindOfStatus(status: number | undefined): CliErrorKind | undefined {
  if (status === undefined) return undefined;
  if (status === 401 || status === 403) return 'not_logged_in';
  if (status === 402) return 'quota';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status === 400) return 'invalid_request';
  return undefined;
}

/** 错误文字只取第一行并截短，日志和提示里不带大段输出 */
export function firstLine(text: string | undefined, max = 200): string {
  return (text ?? '').trim().split('\n')[0]!.slice(0, max);
}

/** 运行本身的问题：启动失败、中止、超时、输出过大 */
export function runErrorOf(provider: CliLlmProvider, exit: CliExit): CliError | undefined {
  if (exit.spawnError) return exit.spawnError;
  if (exit.aborted) return cliError(provider, 'cancelled');
  if (exit.timedOut) return cliError(provider, 'timeout', `no result after ${exit.ms}ms`);
  if (exit.outputTooLarge) return cliError(provider, 'bad_response', 'output exceeded the size limit');
  return undefined;
}
