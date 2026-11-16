import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

/**
 * 只解码 SCIP 转换成边需要的字段（字段号见 scip.proto）。
 * 手写读取而不是生成全部类型：用到的字段很少，避免引入代码生成步骤。
 */

/** SymbolRole 位标记 */
export const SCIP_ROLE_DEFINITION = 0x1;
export const SCIP_ROLE_IMPORT = 0x2;

/** 0 起始的行列；单行范围的 endLine 等于 startLine */
export interface ScipRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface ScipOccurrence {
  range: ScipRange;
  symbol: string;
  roles: number;
  enclosingRange?: ScipRange;
}

export interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
}

export interface ScipIndex {
  documents: ScipDocument[];
}

function readPackedInt32(r: BinaryReader, wireType: WireType, out: number[]): void {
  if (wireType === WireType.LengthDelimited) {
    const end = r.uint32() + r.pos;
    while (r.pos < end) out.push(r.int32());
  } else {
    out.push(r.int32());
  }
}

function toRange(v: number[]): ScipRange | undefined {
  if (v.length === 3) return { startLine: v[0]!, startChar: v[1]!, endLine: v[0]!, endChar: v[2]! };
  if (v.length === 4) return { startLine: v[0]!, startChar: v[1]!, endLine: v[2]!, endChar: v[3]! };
  return undefined;
}

/**
 * SCIP v0.10 起的位置子消息：SingleLineRange 为 (line, start_character, end_character)，
 * MultiLineRange 为 (start_line, start_character, end_line, end_character)；没写的字段为 0
 */
function readRangeMessage(r: BinaryReader, multiLine: boolean): ScipRange {
  const v = multiLine ? [0, 0, 0, 0] : [0, 0, 0];
  const end = r.uint32() + r.pos;
  while (r.pos < end) {
    const [no, wt] = r.tag();
    if (no >= 1 && no <= v.length && wt === WireType.Varint) v[no - 1] = r.int32();
    else r.skip(wt, no);
  }
  return toRange(v)!;
}

/** Occurrence 的位置：旧格式为打包的 range（字段 1）和 enclosing_range（字段 7），新格式为字段 8/9 和 10/11 */
function readOccurrence(r: BinaryReader, len: number): ScipOccurrence | undefined {
  const end = r.pos + len;
  const range: number[] = [];
  const enclosing: number[] = [];
  let rg: ScipRange | undefined;
  let enc: ScipRange | undefined;
  let symbol = '';
  let roles = 0;
  while (r.pos < end) {
    const [no, wt] = r.tag();
    if (no === 1) readPackedInt32(r, wt, range);
    else if (no === 2) symbol = r.string();
    else if (no === 3) roles = r.int32();
    else if (no === 7) readPackedInt32(r, wt, enclosing);
    else if (no === 8 || no === 9) rg = readRangeMessage(r, no === 9);
    else if (no === 10 || no === 11) enc = readRangeMessage(r, no === 11);
    else r.skip(wt, no);
  }
  rg ??= toRange(range);
  return rg ? { range: rg, symbol, roles, enclosingRange: enc ?? toRange(enclosing) } : undefined;
}

function readDocument(r: BinaryReader, len: number): ScipDocument {
  const end = r.pos + len;
  const doc: ScipDocument = { relativePath: '', occurrences: [] };
  while (r.pos < end) {
    const [no, wt] = r.tag();
    if (no === 1) doc.relativePath = r.string();
    else if (no === 2) {
      const occ = readOccurrence(r, r.uint32());
      if (occ) doc.occurrences.push(occ);
    } else r.skip(wt, no);
  }
  return doc;
}

export function decodeScipIndex(buf: Uint8Array): ScipIndex {
  const r = new BinaryReader(buf);
  const documents: ScipDocument[] = [];
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no === 2) documents.push(readDocument(r, r.uint32()));
    else r.skip(wt, no);
  }
  return { documents };
}
