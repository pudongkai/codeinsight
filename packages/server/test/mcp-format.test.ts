import { describe, expect, it } from 'vitest';
import type { SnapshotRow } from '@codeinsight/core';
import { notFoundText, resolverNote } from '../src/mcp/format.js';

function snap(over: Partial<SnapshotRow>): SnapshotRow {
  return {
    id: 1, kind: 'working', commitSha: 'a'.repeat(40), contentKey: 'k', extractStatus: 'ok', resolverStatus: 'ok',
    resolverError: null, edgeSources: null, createdAt: 1, lastUsedAt: 1, ...over,
  };
}

describe('resolverNote', () => {
  it('says nothing when resolution succeeded', () => {
    expect(resolverNote(snap({ edgeSources: { python: { source: 'scip' } } }))).toEqual([]);
  });

  it('names the failed language when only some languages failed', () => {
    const note = resolverNote(snap({
      resolverStatus: 'failed', resolverError: 'go: boom\ndetail',
      edgeSources: { python: { source: 'scip' }, go: { source: 'failed', note: 'boom' } },
    }));
    expect(note).toEqual(['> Warning: Go call graph unavailable (resolver failed: boom); callers of Go symbols are missing.', '']);
  });

  it('labels Rust in per-language warnings', () => {
    const note = resolverNote(snap({ resolverStatus: 'failed', edgeSources: { rust: { source: 'failed', note: 'boom' } } }));
    expect(note[0]).toBe('> Warning: Rust call graph unavailable (resolver failed: boom); callers of Rust symbols are missing.');
  });

  it('keeps the general warning when the whole resolution failed', () => {
    const note = resolverNote(snap({ resolverStatus: 'failed', resolverError: 'scip-python exited\nmore' }));
    expect(note).toEqual(['> Warning: call graph unavailable (resolver failed: scip-python exited); caller lists are empty.', '']);
  });
});

describe('notFoundText', () => {
  it('mentions the Rust path form', () => {
    expect(notFoundText('x')).toContain('crate::module::Type::method');
    expect(notFoundText('x')).toContain('<crate>::module::Type::method');
    expect(notFoundText('x')).toContain('Type::method');
  });
});
