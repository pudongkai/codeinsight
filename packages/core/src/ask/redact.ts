import { isWriteTool } from './events.js';

/** 顶层原样保留的字段（只在是字符串时保留） */
const KEEP_TOP = new Set(['root', 'summary', 'title', 'base', 'branch']);

/** 换成字数：字符串按长度，其他值（含嵌套对象、数组）按 JSON 长度 */
function chars(v: unknown): number {
  return typeof v === 'string' ? v.length : (JSON.stringify(v) ?? '').length;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** files 的一项只留字符串 path，其余字段换成字数 */
function redactFile(f: unknown): unknown {
  if (!isObject(f)) return chars(f);
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === 'path' && typeof v === 'string' ? v : chars(v)]));
}

/** fromWorkingTree 只留字符串数组 paths，其余字段换成字数 */
function redactWorkingTree(w: unknown): unknown {
  if (!isObject(w)) return chars(w);
  const keep = (k: string, v: unknown) => k === 'paths' && Array.isArray(v) && v.every((p) => typeof p === 'string');
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, keep(k, v) ? v : chars(v)]));
}

function redactField(key: string, v: unknown): unknown {
  if (KEEP_TOP.has(key) && typeof v === 'string') return v;
  if (key === 'files' && Array.isArray(v)) return v.map(redactFile);
  if (key === 'fromWorkingTree') return redactWorkingTree(v);
  return chars(v);
}

/**
 * 写工具的参数去掉文件内容后再发事件、存 toolCalls、写日志。按白名单保留：顶层的 root、summary、title、base、branch，
 * files[].path 和 fromWorkingTree.paths；其余字段（create、edits、body 和模型多给的字段）一律换成字数。
 * 其他工具的参数原样返回。
 */
export function redactWriteArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!isWriteTool(name)) return args;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, redactField(k, v)]));
}
