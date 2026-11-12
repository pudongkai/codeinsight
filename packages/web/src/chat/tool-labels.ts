import type { AskLimitReason, AskToolError } from '@codeinsight/core/ask/events';

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

/** 工具调用进度的一行说明，如“搜索符号 refund”“读取 server/billing/service.py:40-120” */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  const f = LABELS[name];
  return f ? f(args).trim() : `${name} ${JSON.stringify(args)}`;
}

export const TOOL_ERROR_LABELS: Record<AskToolError, string> = {
  not_found: '没有找到',
  path_not_allowed: '路径不允许',
  file_changed: '文件已变化',
  file_too_large: '文件太大',
  invalid_args: '参数不合法',
  overview_missing: '还没有概览',
  internal_error: '内部错误',
};

export const LIMIT_LABELS: Record<AskLimitReason, string> = {
  max_rounds: '已达到工具调用轮数上限，回答可能不完整',
  max_tool_chars: '工具查询结果总量已达到上限，回答可能不完整',
  max_tokens: '回答因长度上限被截断',
};
