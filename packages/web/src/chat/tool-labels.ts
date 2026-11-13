import { PROPOSE_FILE_CHANGES, PROPOSE_PULL_REQUEST, type AskLimitReason, type AskToolError } from '@codeinsight/core/ask/events';

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function readLabel(args: Record<string, unknown>): string {
  const path = str(args.path);
  if (!path) return `读取符号源码 ${str(args.id)}`;
  const start = str(args.start);
  const end = str(args.end);
  return `读取 ${path}${start ? `:${start}${end ? `-${end}` : ''}` : ''}`;
}

const LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  search_symbols: (a) => `搜索符号 ${str(a.query)}`,
  get_symbol: (a) => `查看符号 ${str(a.id)}`,
  get_call_graph: (a) => `查${a.direction === 'callers' ? '调用方' : '被调用方'} ${str(a.id)}`,
  read_source: readLabel,
  grep_code: (a) => `搜索代码 “${str(a.text)}”${a.pathPrefix ? `（${str(a.pathPrefix)}）` : ''}`,
  list_entries: (a) => `列出入口${a.kind ? ` ${str(a.kind)}` : ''}${a.pathContains ? `（${str(a.pathContains)}）` : ''}`,
  get_module: (a) => (a.module ? `查看模块 ${str(a.module)}` : '查看模块列表'),
};

const fileCount = (a: Record<string, unknown>): string => (Array.isArray(a.files) ? `（${a.files.length} 个文件）` : '');

/** 写工具只生成待确认的修改，不直接写盘；参数里没有文件内容 */
const WRITE_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  [PROPOSE_FILE_CHANGES]: (a) => `生成待确认修改 ${str(a.summary)}${fileCount(a)}`,
  [PROPOSE_PULL_REQUEST]: (a) => `生成待确认 PR ${str(a.title)}${fileCount(a)}`,
};

/** 工具调用进度的一行说明，如“搜索符号 refund”“读取 server/billing/service.py:40-120” */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  const f = LABELS[name] ?? WRITE_LABELS[name];
  return f ? f(args).trim() : `${name} ${JSON.stringify(args)}`;
}

/** 工具错误码的说明；待确认修改的执行结果也用到这些错误码，说法共用这一份 */
export const TOOL_ERROR_LABELS: Record<AskToolError, string> = {
  not_found: '没有找到对应的内容',
  path_not_allowed: '路径不允许',
  file_changed: '文件已变化',
  file_too_large: '文件太大',
  invalid_args: '参数不合法',
  overview_missing: '还没有概览',
  internal_error: '内部错误',
  write_not_allowed: '不允许写入这个位置',
};

export const LIMIT_LABELS: Record<AskLimitReason, string> = {
  max_rounds: '已达到工具调用轮数上限，回答可能不完整',
  max_tool_chars: '工具查询结果总量已达到上限，回答可能不完整',
  max_tokens: '回答因长度上限被截断',
};
