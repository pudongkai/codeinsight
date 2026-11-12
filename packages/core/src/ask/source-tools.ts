import { log } from '../log.js';
import type { FileRow, SymbolRow } from '../model/types.js';
import { readSnapshotFile, readSnapshotFileRow, SnapshotFileError, sliceLines } from '../snapshot/source.js';
import { checkRelativePath, PathNotAllowedError } from '../util/paths.js';
import { findSymbol } from './symbol-tools.js';
import { AskToolFailure, optInt, optString, reqString, type ToolArgs } from './tool-args.js';
import { entriesOf, output, symbolLine, type AskToolContext, type ToolOutput } from './tool-context.js';

/** read_source 每次最多返回的行数 */
export const MAX_READ_LINES = 200;
const MAX_GREP = 50;
/** grep_code 跳过超过这个大小的文件 */
const GREP_MAX_BYTES = 1024 * 1024;
const GREP_LINE_CHARS = 200;

function readFile(ctx: AskToolContext, path: string): Promise<string> {
  return readSnapshotFile({ repo: ctx.repo, store: ctx.store, layout: ctx.layout }, ctx.snapshot, path);
}

/** 带行号的源码 */
function numbered(content: string, start: number): string {
  return content.split('\n').map((l, i) => `${start + i}| ${l}`).join('\n');
}

/** 符号的签名、docstring 首行和位置（关闭源码发送时代替源码） */
function signatureOnly(ctx: AskToolContext, symbols: SymbolRow[]): string {
  const entries = entriesOf(ctx, symbols.map((s) => s.id));
  return symbols.map((s) => {
    const doc = s.docstring?.split('\n').find((l) => l.trim())?.trim();
    return [symbolLine(ctx, s, entries, { signature: true }), ...(doc ? [`  doc: ${doc}`] : [])].join('\n');
  }).join('\n');
}

const NO_SOURCE_NOTE = '(source sending is turned off: only signatures and locations are returned, no code)';

async function readRange(ctx: AskToolContext, path: string, start: number, end: number): Promise<{ text: string; total: number }> {
  const range = sliceLines(await readFile(ctx, path), start, end);
  if (!range) throw new AskToolFailure('invalid_args', '`end` is before `start`');
  return { text: `${path}:${range.start}-${range.end} (file has ${range.totalLines} lines)\n${numbered(range.content, range.start)}`, total: range.totalLines };
}

async function readSymbolSource(ctx: AskToolContext, id: string): Promise<ToolOutput> {
  const s = findSymbol(ctx, id);
  if (!ctx.sendSource) return output(`${NO_SOURCE_NOTE}\n${signatureOnly(ctx, [s])}`, [s]);
  const end = Math.min(s.endLine, s.startLine + MAX_READ_LINES - 1);
  const { text } = await readRange(ctx, s.path, s.startLine, end);
  const more = end < s.endLine ? `\n(symbol ends at line ${s.endLine}; call read_source with path, start=${end + 1} for the rest)` : '';
  return output(`${s.qualifiedName} (${s.id})\n${text}${more}`, [s]);
}

/** 清单里的文件才能读；关闭源码发送时也要检查，不读内容 */
function checkListed(ctx: AskToolContext, path: string): void {
  checkRelativePath(path);
  if (!ctx.store.getFile(ctx.snapshot.id, path)) throw new SnapshotFileError('not_in_snapshot', path);
}

async function readPathSource(ctx: AskToolContext, path: string, args: ToolArgs): Promise<ToolOutput> {
  const start = optInt(args, 'start', { min: 1, max: Number.MAX_SAFE_INTEGER, def: 1 });
  const wanted = optInt(args, 'end', { min: start, max: Number.MAX_SAFE_INTEGER, def: start + MAX_READ_LINES - 1 });
  const end = Math.min(wanted, start + MAX_READ_LINES - 1);
  if (!ctx.sendSource) {
    checkListed(ctx, path);
    const inRange = ctx.store.getSymbolsByPaths(ctx.snapshot.id, [path]).filter((s) => s.startLine <= end && s.endLine >= start && s.kind !== 'module');
    return output(`${NO_SOURCE_NOTE}\nSymbols in ${path}:${start}-${end}:\n${inRange.length ? signatureOnly(ctx, inRange) : '(none)'}`, inRange);
  }
  const { text } = await readRange(ctx, path, start, end);
  const more = wanted > end ? `\n(at most ${MAX_READ_LINES} lines per call; continue with start=${end + 1})` : '';
  return output(text + more);
}

export function readSource(ctx: AskToolContext, args: ToolArgs): Promise<ToolOutput> {
  const id = optString(args, 'id');
  if (id) return readSymbolSource(ctx, id);
  const path = optString(args, 'path');
  if (!path) throw new AskToolFailure('invalid_args', 'pass `id`, or `path` with optional `start` and `end`');
  return readPathSource(ctx, path, args);
}

interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/**
 * 读文件用于搜索：太大、内容已变、不存在、路径不允许（如指向仓库外的符号链接）、二进制的文件跳过；
 * 其他读错误（权限、是目录等）记日志后跳过，不让一个文件拖垮整次搜索。
 */
async function readForGrep(ctx: AskToolContext, row: FileRow): Promise<string | undefined> {
  try {
    const text = await readSnapshotFileRow({ repo: ctx.repo, store: ctx.store, layout: ctx.layout }, ctx.snapshot, row, { maxBytes: GREP_MAX_BYTES });
    return text.includes('\0') ? undefined : text;
  } catch (err) {
    if (!(err instanceof SnapshotFileError) && !(err instanceof PathNotAllowedError)) {
      log.warn('ask_grep_file_skipped', { path: row.path, error: (err as Error).message.split('\n')[0] });
    }
    return undefined;
  }
}

async function grepFiles(ctx: AskToolContext, needle: string, prefix: string, limit: number): Promise<{ hits: GrepHit[]; more: boolean }> {
  const hits: GrepHit[] = [];
  const files = ctx.store.getFiles(ctx.snapshot.id).filter((f) => f.path.startsWith(prefix));
  for (const f of files) {
    const text = await readForGrep(ctx, f);
    ctx.signal?.throwIfAborted();
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.toLowerCase().includes(needle)) continue;
      if (hits.length === limit) return { hits, more: true };
      hits.push({ path: f.path, line: i + 1, text: lines[i]!.trim().slice(0, GREP_LINE_CHARS) });
    }
  }
  return { hits, more: false };
}

/** 包含这一行的最内层符号（不含 module） */
function innermost(symbols: SymbolRow[], hit: GrepHit): SymbolRow | undefined {
  let best: SymbolRow | undefined;
  for (const s of symbols) {
    if (s.path !== hit.path || s.kind === 'module' || s.startLine > hit.line || s.endLine < hit.line) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best;
}

export async function grepCode(ctx: AskToolContext, args: ToolArgs): Promise<ToolOutput> {
  const text = reqString(args, 'text');
  const prefix = (optString(args, 'pathPrefix') ?? '').replace(/^\.\//, '');
  const limit = optInt(args, 'limit', { min: 1, max: MAX_GREP, def: 20 });
  const { hits, more } = await grepFiles(ctx, text.toLowerCase(), prefix, limit);
  if (hits.length === 0) return output(`No lines contain "${text}".`);
  const symbols = ctx.store.getSymbolsByPaths(ctx.snapshot.id, [...new Set(hits.map((h) => h.path))]);
  const used = new Map<string, SymbolRow>();
  const lines = hits.map((h) => {
    const s = innermost(symbols, h);
    if (s) used.set(s.id, s);
    const where = s ? ` [in ${s.qualifiedName} ${s.id}]` : '';
    return ctx.sendSource ? `${h.path}:${h.line}${where}: ${h.text}` : `${h.path}:${h.line}${where}`;
  });
  if (!ctx.sendSource) lines.unshift(NO_SOURCE_NOTE);
  if (more) lines.push(`(more matches not shown; narrow with pathPrefix or raise limit up to ${MAX_GREP})`);
  return output(lines.join('\n'), [...used.values()]);
}
