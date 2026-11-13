import type { ToolSpec } from '../llm/chat.js';
import { log } from '../log.js';
import { SnapshotFileError } from '../snapshot/source.js';
import { PathNotAllowedError } from '../util/paths.js';
import type { AskToolError } from './events.js';
import { grepCode, MAX_READ_LINES, readSource } from './source-tools.js';
import { getCallGraph, getModule, getSymbol, listEntries, searchSymbols } from './symbol-tools.js';
import { argsObject, AskToolFailure, type ToolArgs } from './tool-args.js';
import { output, type AskToolContext, type ToolOutput } from './tool-context.js';

export type { AskToolContext, ToolOutput } from './tool-context.js';

/** 单个工具结果回给模型前截到这么多字符 */
export const MAX_TOOL_RESULT_CHARS = 8000;

/** 工具结果累计超过上限后，剩下的调用不执行，回给模型这句话 */
export const TOOL_LIMIT_RESULT = 'error: skipped: the tool result limit for this question was reached; answer with what you already have';

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** 问答工具集：都只读、都作用于当前快照，不能写文件、执行命令、访问网络 */
export const ASK_TOOLS: ToolSpec[] = [
  {
    name: 'search_symbols',
    description: 'Find functions, classes and methods whose name contains the query (case-insensitive). Returns id, kind, qualified name, location, signature, entry / model marks and module.',
    inputSchema: schema({ query: str('Part of a symbol name, e.g. "refund"'), kind: str('Only this kind: function, method, class'), limit: int('At most 20, default 10') }, ['query']),
  },
  {
    name: 'get_symbol',
    description: 'Details of one symbol by id: signature, docstring, entry (HTTP method and path), model kind, module, number of callers and callees.',
    inputSchema: schema({ id: str('Symbol id from another tool result') }, ['id']),
  },
  {
    name: 'get_call_graph',
    description: 'Callers or callees of a symbol, listed by depth, at most 50 symbols.',
    inputSchema: schema({
      id: str('Symbol id'), direction: { type: 'string', enum: ['callers', 'callees'] },
      depth: int('1 to 3, default 1'), includeTests: { type: 'boolean', description: 'Include test code, default false' },
    }, ['id', 'direction']),
  },
  {
    name: 'read_source',
    description: `Source code with line numbers, at most ${MAX_READ_LINES} lines per call. Pass id to read a symbol, or path with optional start and end lines.`,
    inputSchema: schema({ id: str('Symbol id'), path: str('File path relative to the repository root'), start: int('First line, from 1'), end: int('Last line') }),
  },
  {
    name: 'grep_code',
    description: 'Lines containing the literal text (not a regex, case-insensitive) in indexed files. Returns path:line, the enclosing symbol and the line.',
    inputSchema: schema({ text: str('Literal text to find'), pathPrefix: str('Only files under this path'), limit: int('At most 50, default 20') }, ['text']),
  },
  {
    name: 'list_entries',
    description: 'Entry points (HTTP endpoints, CLI commands, scheduled jobs, ...) with their handler symbol ids, at most 100.',
    inputSchema: schema({ kind: str('Entry kind, e.g. http'), pathContains: str('Only handlers whose file path contains this') }),
  },
  {
    name: 'get_module',
    description: 'From the system overview: without module, the module list (id, name, responsibility); with module, its responsibility, interfaces, models, external dependencies, dependencies, features and boundary issues.',
    inputSchema: schema({ module: str('Module id or name') }),
  },
];

type ToolFn = (ctx: AskToolContext, args: ToolArgs) => ToolOutput | Promise<ToolOutput>;

const HANDLERS: Record<string, ToolFn> = {
  search_symbols: searchSymbols, get_symbol: getSymbol, get_call_graph: getCallGraph, read_source: readSource,
  grep_code: grepCode, list_entries: listEntries, get_module: getModule,
};

export interface ToolRun extends ToolOutput {
  error?: AskToolError;
}

/** 读文件和路径错误转成通用错误码和简短说明；其他异常为 internal_error */
function toFailure(err: unknown): AskToolFailure {
  if (err instanceof AskToolFailure) return err;
  if (err instanceof PathNotAllowedError) return new AskToolFailure('path_not_allowed', 'this path is not allowed; use a path relative to the repository root');
  if (err instanceof SnapshotFileError) {
    if (err.code === 'file_changed') return new AskToolFailure('file_changed', 'the file changed after indexing; its content is not available');
    if (err.code === 'file_too_large') return new AskToolFailure('file_too_large', 'the file is too large to read');
    return new AskToolFailure('not_found', 'no such file in the current snapshot');
  }
  return new AskToolFailure('internal_error', 'the tool failed');
}

/**
 * 执行一个工具。参数不合法、目标不存在等错误作为结果返回（error 为通用错误码），不抛出；
 * 回给模型的说明不含绝对路径和异常原文，详情只写日志。
 */
export async function runAskTool(ctx: AskToolContext, name: string, input: unknown): Promise<ToolRun> {
  const fn = HANDLERS[name];
  try {
    if (!fn) throw new AskToolFailure('invalid_args', `unknown tool; available: ${Object.keys(HANDLERS).join(', ')}`);
    return await fn(ctx, argsObject(input));
  } catch (err) {
    // 中止不是工具错误，交给问答循环按取消或超时结束
    if (ctx.signal?.aborted) throw err;
    const f = toFailure(err);
    if (f.code === 'internal_error') log.error('ask_tool_error', { tool: name, error: (err as Error).message.split('\n')[0], stack: (err as Error).stack?.split('\n')[1]?.trim() });
    else log.info('ask_tool_rejected', { tool: name, code: f.code, detail: (err as Error).message.split('\n')[0] });
    return failureRun(f.code, f.message);
  }
}

/** 单个结果截到 max 字符并注明总长度 */
export function truncateToolResult(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

function failureRun(code: AskToolError, message: string): ToolRun {
  return { ...output(`error: ${code}: ${message}`), error: code };
}

/** 模型给的工具参数不是合法 JSON 时回给它的结果 */
export function invalidArgsRun(): ToolRun {
  return failureRun('invalid_args', 'the arguments are not valid JSON');
}
