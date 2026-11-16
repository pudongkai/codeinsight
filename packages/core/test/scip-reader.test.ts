import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { describe, expect, it } from 'vitest';
import { decodeScipIndex, SCIP_ROLE_DEFINITION, type ScipOccurrence } from '../src/index.js';

/** scip-go v0.2.9（SCIP 绑定 v0.10.0）对 fixtures/scip-go-mini 生成的索引，位置写在字段 8-11 */
const GO_INDEX = path.join(import.meta.dirname, 'fixtures', 'scip-go-mini', 'index.scip');

const PKG = 'scip-go gomod example.com/mini v0.0.0 `example.com/mini/shop`/';

function find(occs: ScipOccurrence[], symbol: string, definition: boolean): ScipOccurrence[] {
  return occs.filter((o) => o.symbol === symbol && Boolean(o.roles & SCIP_ROLE_DEFINITION) === definition);
}

/** 一个 document、一个 occurrence 的索引；fill 写 occurrence 的字段 */
function encodeIndex(fill: (w: BinaryWriter) => void): Uint8Array {
  const occ = new BinaryWriter();
  occ.tag(2, WireType.LengthDelimited).string('x/f().');
  occ.tag(3, WireType.Varint).int32(SCIP_ROLE_DEFINITION);
  fill(occ);
  const doc = new BinaryWriter();
  doc.tag(1, WireType.LengthDelimited).string('a.py');
  doc.tag(2, WireType.LengthDelimited).bytes(occ.finish());
  return new BinaryWriter().tag(2, WireType.LengthDelimited).bytes(doc.finish()).finish();
}

describe('decodeScipIndex', () => {
  it('reads the range sub-messages written by scip-go', () => {
    const index = decodeScipIndex(readFileSync(GO_INDEX));
    expect(index.documents.map((d) => d.relativePath)).toEqual(['shop/shop.go']);
    const occs = index.documents[0]!.occurrences;
    expect(occs.length).toBeGreaterThan(20);
    for (const o of occs) expect(o.range.endChar).toBeGreaterThan(o.range.startChar);

    // 方法定义：单行名字范围，多行 enclosing_range
    const [get] = find(occs, `${PKG}Service#Get().`, true);
    expect(get).toMatchObject({
      range: { startLine: 20, startChar: 18, endLine: 20, endChar: 21 },
      enclosingRange: { startLine: 20, startChar: 0, endLine: 23, endChar: 1 },
    });
    // interface 方法：单行 enclosing_range
    expect(find(occs, `${PKG}Repo#Find.`, true)[0]?.enclosingRange).toEqual({ startLine: 5, startChar: 1, endLine: 5, endChar: 20 });
    // 包定义没有 enclosing_range
    expect(find(occs, PKG, true)[0]).toMatchObject({ range: { startLine: 1, startChar: 8, endLine: 1, endChar: 12 }, enclosingRange: undefined });
    // 引用：经接口字段的调用
    expect(find(occs, `${PKG}Repo#Find.`, false)[0]?.range).toEqual({ startLine: 21, startChar: 16, endLine: 21, endChar: 20 });
    const defs = occs.filter((o) => o.roles & SCIP_ROLE_DEFINITION && !o.symbol.startsWith('local '));
    expect(defs.filter((o) => o.enclosingRange).length).toBe(defs.length - 1);
  });

  it('treats omitted fields of the range sub-messages as 0', () => {
    const buf = encodeIndex((w) => {
      // SingleLineRange 只写 end_character；MultiLineRange 只写 end_line、end_character
      w.tag(8, WireType.LengthDelimited).fork().tag(3, WireType.Varint).int32(3).join();
      w.tag(11, WireType.LengthDelimited).fork().tag(3, WireType.Varint).int32(2).tag(4, WireType.Varint).int32(1).join();
    });
    expect(decodeScipIndex(buf).documents[0]!.occurrences[0]).toMatchObject({
      range: { startLine: 0, startChar: 0, endLine: 0, endChar: 3 },
      enclosingRange: { startLine: 0, startChar: 0, endLine: 2, endChar: 1 },
    });
  });

  it('still reads the packed range and enclosing_range fields', () => {
    const buf = encodeIndex((w) => {
      w.tag(1, WireType.LengthDelimited).fork().int32(4).int32(4).int32(5).join();
      w.tag(7, WireType.LengthDelimited).fork().int32(4).int32(0).int32(6).int32(8).join();
    });
    expect(decodeScipIndex(buf).documents[0]!.occurrences[0]).toMatchObject({
      range: { startLine: 4, startChar: 4, endLine: 4, endChar: 5 },
      enclosingRange: { startLine: 4, startChar: 0, endLine: 6, endChar: 8 },
    });
  });
});
