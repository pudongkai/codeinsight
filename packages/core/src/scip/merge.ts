import path from 'node:path';
import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';

/** Document 的 relative_path（字段 1） */
function documentPath(bytes: Uint8Array): string | undefined {
  const r = new BinaryReader(bytes);
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no === 1 && wt === WireType.LengthDelimited) return r.string();
    r.skip(wt, no);
  }
  return undefined;
}

/** Document 的 relative_path（字段 1）加上前缀，其他字段原样复制 */
export function prefixDocument(bytes: Uint8Array, prefix: string): Uint8Array {
  const r = new BinaryReader(bytes);
  const w = new BinaryWriter();
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no === 1 && wt === WireType.LengthDelimited) w.tag(1, WireType.LengthDelimited).string(path.posix.join(prefix, r.string()));
    else w.tag(no, wt).raw(r.skip(wt, no));
  }
  return w.finish();
}

/**
 * 把一个索引里的文档（字段 2）写进合并结果，文档路径加上 prefix；其他字段丢弃。
 * 给了 keep 时只保留加前缀后的路径通过 keep 的文档
 */
export function appendScipDocuments(out: BinaryWriter, index: Uint8Array, prefix: string, keep?: (relativePath: string) => boolean): void {
  const r = new BinaryReader(index);
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    if (no !== 2 || wt !== WireType.LengthDelimited) {
      r.skip(wt, no);
      continue;
    }
    const raw = r.bytes();
    const doc = prefix ? prefixDocument(raw, prefix) : raw;
    if (keep && !keep(documentPath(doc) ?? '')) continue;
    out.tag(2, WireType.LengthDelimited).bytes(doc);
  }
}
