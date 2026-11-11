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

function readOccurrence(r: BinaryReader, len: number): ScipOccurrence | undefined {
  const end = r.pos + len;
  const range: number[] = [];
  const enclosing: number[] = [];
  let symbol = '';
  let roles = 0;
  while (r.pos < end) {
    const [no, wt] = r.tag();
    if (no === 1) readPackedInt32(r, wt, range);
    else if (no === 2) symbol = r.string();
    else if (no === 3) roles = r.int32();
    else if (no === 7) readPackedInt32(r, wt, enclosing);
    else r.skip(wt, no);
  }
  const rg = toRange(range);
  return rg ? { range: rg, symbol, roles, enclosingRange: toRange(enclosing) } : undefined;
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
