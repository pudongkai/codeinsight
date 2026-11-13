import { AskToolFailure } from './tool-args.js';

const BOM = '\uFEFF';

/** 解码后的文本文件：正文（不含 BOM）、原来有没有 BOM、原来的换行符 */
export interface TextFile {
  text: string;
  bom: boolean;
  eol: '\n' | '\r\n';
}

export interface TextEdit {
  old: string;
  new: string;
}

/** CRLF 比单独的 LF 多时按 CRLF */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * 按 UTF-8 解码；含 NUL（二进制）或解码后再编码和原字节不一致（GBK 等）时返回 undefined，
 * 这类文件改了会被破坏，不接受修改
 */
export function decodeTextFile(bytes: Uint8Array): TextFile | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.includes(0)) return undefined;
  const decoded = buf.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(buf)) return undefined;
  const bom = decoded.startsWith(BOM);
  const text = bom ? decoded.slice(1) : decoded;
  return { text, bom, eol: detectEol(text) };
}

/** 写回磁盘的完整内容：保留原来的 BOM */
export function withBom(text: string, bom: boolean): string {
  return bom ? BOM + text : text;
}

/** 模型给的文字统一成文件原来的换行符 */
export function toEol(s: string, eol: '\n' | '\r\n'): string {
  const lf = s.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

/** old 在 text 里的位置；不止一处时返回 -2，找不到时 -1 */
function uniqueIndex(text: string, old: string): number {
  const at = text.indexOf(old);
  if (at < 0) return -1;
  return text.indexOf(old, at + 1) >= 0 ? -2 : at;
}

/** 按原文匹配时 new 的换行跟着 old 的写法；old 没有换行时按文件的换行 */
function eolOf(old: string, fallback: '\n' | '\r\n'): '\n' | '\r\n' {
  if (old.includes('\r\n')) return '\r\n';
  return old.includes('\n') ? '\n' : fallback;
}

/** 一处修改：先按原文匹配，匹配不上再把换行统一成文件原来的再匹配 */
function applyOne(text: string, e: TextEdit, eol: '\n' | '\r\n', n: number): string {
  if (/\r(?!\n)/.test(e.old) || /\r(?!\n)/.test(e.new)) throw new AskToolFailure('invalid_args', `edit ${n}: a lone carriage return (\\r) is not allowed`);
  let old = e.old;
  let next = toEol(e.new, eolOf(e.old, eol));
  let at = uniqueIndex(text, old);
  // 以 \n 开头的原文正好接在 \r 后面时会拆开一个 CRLF，按换行统一后的内容再匹配
  if (at > 0 && old.startsWith('\n') && text[at - 1] === '\r') at = -1;
  if (at === -1) {
    old = toEol(e.old, eol);
    next = toEol(e.new, eol);
    at = old === e.old ? -1 : uniqueIndex(text, old);
  }
  if (at === -1) throw new AskToolFailure('invalid_args', `edit ${n}: old text not found; copy it exactly from read_source, without the line-number prefix`);
  if (at === -2) throw new AskToolFailure('invalid_args', `edit ${n}: old text appears more than once; include more surrounding lines so it is unique`);
  return text.slice(0, at) + next + text.slice(at + old.length);
}

/**
 * 按顺序应用 edits：每个 old 必须在当前内容里恰好出现一次（先按原文，再按换行统一成文件原来的），替换成 new。
 * 找不到、不止一处或含单独的 \r 时抛 invalid_args，说明是第几处。返回修改后的正文（不含 BOM）。
 */
export function applyEdits(file: TextFile, edits: readonly TextEdit[]): string {
  return edits.reduce((text, e, i) => applyOne(text, e, file.eol, i + 1), file.text);
}
