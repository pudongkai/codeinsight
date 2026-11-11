/**
 * 极简日志：一行一条写到 stderr（stdout 留给命令输出和 JSON 结果）。
 * 级别由环境变量 CODEINSIGHT_LOG 控制：debug | info | warn | error | silent，默认 info。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

type Sink = (line: string) => void;
let sink: Sink = (line) => process.stderr.write(line + '\n');

/** 替换输出目标（测试或嵌入 server 时使用），返回原来的目标 */
export function setLogSink(next: Sink): Sink {
  const prev = sink;
  sink = next;
  return prev;
}

function threshold(): number {
  const env = (process.env.CODEINSIGHT_LOG ?? 'info').toLowerCase() as LogLevel | 'silent';
  return ORDER[env] ?? ORDER.info;
}

function format(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`)
    .join(' ');
}

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const rest = format(fields);
  sink(`${new Date().toISOString()} ${level.toUpperCase()} ${event}${rest ? ' ' + rest : ''}`);
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => emit('debug', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => emit('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit('error', event, fields),
};
