import type { ToolSpec } from '../llm/chat.js';
import { log } from '../log.js';
import { SnapshotFileError } from '../snapshot/source.js';
import { PathNotAllowedError } from '../util/paths.js';
import { buildFilesProposal, buildPullRequestProposal, MAX_PROPOSAL_FILES } from './build-proposal.js';
import { PROPOSE_FILE_CHANGES, PROPOSE_PULL_REQUEST, type AskToolError } from './events.js';
import { grepCode, MAX_READ_LINES, readSource } from './source-tools.js';
import { getCallGraph, getModule, getSymbol, listEntries, searchSymbols } from './symbol-tools.js';
import { argsObject, AskToolFailure, type ToolArgs } from './tool-args.js';
import { output, type AskToolContext, type ToolOutput } from './tool-context.js';
import { WriteNotAllowedError } from './write-scope.js';

export type { AskToolContext, ToolOutput, WriteToolsContext } from './tool-context.js';

/** 单个工具结果回给模型前截到这么多字符 */
export const MAX_TOOL_RESULT_CHARS = 8000;

/** 工具结果累计超过上限后，剩下的调用不执行，回给模型这句话 */
export const TOOL_LIMIT_RESULT = 'error: skipped: the tool result limit for this question was reached; answer with what you already have';

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** 查询工具：都只读、都作用于当前快照，不能写文件、执行命令、访问网络 */
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

const FILES_SCHEMA = {
  type: 'array',
  description: `At most ${MAX_PROPOSAL_FILES} files. Give exactly one of create and edits per file.`,
  items: {
    type: 'object',
    properties: {
      path: str('File path relative to the root, using /'),
      create: str('Full content of a new file (the file must not exist)'),
      edits: {
        type: 'array',
        description: 'Changes to an existing file, applied in order; each old must appear exactly once in the file',
        items: schema({ old: str('Exact text copied from read_source, without line-number prefixes'), new: str('Replacement text') }, ['old', 'new']),
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

/** 写工具：只生成待确认的修改，用户在页面上确认后才写入；只在网页问答（有会话）里提供 */
export const WRITE_TOOLS: ToolSpec[] = [
  {
    name: PROPOSE_FILE_CHANGES,
    description: 'Propose creating or changing files. Nothing is written: the user reviews the proposal and applies it in the UI.',
    inputSchema: schema({
      root: str('repo (default, this repository) or one of the extra writable directories (dir1, dir2, ...; new files only)'),
      summary: str('One line describing the change'),
      files: FILES_SCHEMA,
    }, ['summary', 'files']),
  },
  {
    name: PROPOSE_PULL_REQUEST,
    description: 'Propose a GitHub pull request, either with file changes based on origin/<base> or with the uncommitted working tree changes. Nothing is pushed until the user confirms in the UI.',
    inputSchema: schema({
      title: str('Pull request title'),
      body: str('Pull request description (Markdown)'),
      base: str('Target branch, default the default branch of origin'),
      branch: str('New branch name, default codeinsight/<title>-<time>'),
      files: { ...FILES_SCHEMA, description: `${FILES_SCHEMA.description} Paths are relative to the repository; edits apply to the content on origin/<base>.` },
      fromWorkingTree: {
        type: 'object', description: 'Use the uncommitted working tree changes (including untracked, not ignored files) instead of files',
        properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Only these paths; empty or missing means all' } },
        additionalProperties: false,
      },
    }, ['title', 'body']),
  },
];

/** 本次问答提供的工具：有写入环境时加上写工具 */
export function askTools(write: boolean): ToolSpec[] {
  return write ? [...ASK_TOOLS, ...WRITE_TOOLS] : ASK_TOOLS;
}

type ToolFn = (ctx: AskToolContext, args: ToolArgs) => ToolOutput | Promise<ToolOutput>;

/** 写工具成功时回给模型的说明：带这次调用的编号（本机 CLI 路径据此得到执行顺序，见 changeNumber） */
function proposalReady(change: number, what: string, notes: string[]): ToolOutput {
  const lines = [`Proposal ready (change #${change}): ${what}. The user must review and apply it in the UI; nothing has been written yet.`, ...notes.map((n) => `Note: ${n}`)];
  return output(lines.join('\n'));
}

/** 写工具结果第一行里的调用编号；不是成功的写工具结果时为 undefined */
export function changeNumber(text: string): number | undefined {
  const m = /^Proposal ready \(change #(\d+)\)/.exec(text.trimStart());
  return m ? Number(m[1]) : undefined;
}

async function proposeFileChanges(ctx: AskToolContext, args: ToolArgs): Promise<ToolOutput> {
  const { proposal, notes, merge } = await buildFilesProposal(ctx, args);
  return proposalReady(merge.change, `${proposal.files.length} files`, notes);
}

async function proposePullRequest(ctx: AskToolContext, args: ToolArgs): Promise<ToolOutput> {
  const { proposal, notes, merge } = await buildPullRequestProposal(ctx, args);
  const what = proposal.files ? `${proposal.files.length} files` : `the working tree changes${proposal.paths?.length ? ` under ${proposal.paths.length} paths` : ''}`;
  return proposalReady(merge.change, `${what}, branch ${proposal.branch} -> ${proposal.base}`, notes);
}

const READ_HANDLERS: Record<string, ToolFn> = {
  search_symbols: searchSymbols, get_symbol: getSymbol, get_call_graph: getCallGraph, read_source: readSource,
  grep_code: grepCode, list_entries: listEntries, get_module: getModule,
};

const ALL_HANDLERS: Record<string, ToolFn> = { ...READ_HANDLERS, [PROPOSE_FILE_CHANGES]: proposeFileChanges, [PROPOSE_PULL_REQUEST]: proposePullRequest };

function handlersFor(ctx: AskToolContext): Record<string, ToolFn> {
  return ctx.write ? ALL_HANDLERS : READ_HANDLERS;
}

export interface ToolRun extends ToolOutput {
  error?: AskToolError;
}

/** 读文件和路径错误转成通用错误码和简短说明；其他异常为 internal_error */
function toFailure(err: unknown): AskToolFailure {
  if (err instanceof AskToolFailure) return err;
  if (err instanceof WriteNotAllowedError) return new AskToolFailure('write_not_allowed', err.reason);
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
  const handlers = handlersFor(ctx);
  const fn = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  try {
    if (!fn) throw new AskToolFailure('invalid_args', `unknown tool; available: ${Object.keys(handlers).join(', ')}`);
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
