import { languagesWithSource } from '@codeinsight/core';
import type { DuplicateFinding, Language, SnapshotRow, SymbolRow } from '@codeinsight/core';

export function location(s: { path: string; startLine: number }): string {
  return `${s.path}:${s.startLine}`;
}

export function candidatesText(query: string, rows: SymbolRow[]): string {
  return [
    `Multiple symbols match \`${query}\`. Not guessing; call again with \`symbol\` set to one of these keys:`,
    '',
    ...rows.map((s) => `- \`${s.symbolKey}\` — ${s.kind} \`${s.qualifiedName}\` at ${location(s)}${s.isTest ? ' (test)' : ''}`),
  ].join('\n');
}

export function notFoundText(query: string): string {
  return `No symbol named \`${query}\` in the working tree index. Pass a function name, a qualified name such as \`Class.method\` (Rust: \`<crate>::module::Type::method\`, \`crate::module::Type::method\` or \`Type::method\`), or a symbol key.`;
}

const LANGUAGE_LABELS: Partial<Record<Language, string>> = { python: 'Python', go: 'Go', rust: 'Rust' };

/**
 * 解析失败时调用关系为空，要明确告知而不是给出 0 个调用方。只有部分语言失败时按语言说明，
 * 其他语言的调用关系照常可用
 */
export function resolverNote(snap: SnapshotRow): string[] {
  if (snap.resolverStatus === 'ok') return [];
  const failed = languagesWithSource(snap.edgeSources, 'failed');
  if (failed.length > 0) {
    return [...failed.map((l) => {
      const name = LANGUAGE_LABELS[l] ?? l;
      const reason = snap.edgeSources?.[l]?.note ?? 'unknown';
      return `> Warning: ${name} call graph unavailable (resolver failed: ${reason}); callers of ${name} symbols are missing.`;
    }), ''];
  }
  const reason = snap.resolverError?.split('\n')[0] ?? 'unknown';
  return [`> Warning: call graph unavailable (resolver ${snap.resolverStatus}: ${reason}); caller lists are empty.`, ''];
}

/** 一个函数的重复实现候选，按 score 排列 */
export function similarText(title: string, findings: DuplicateFinding[], minScore: number): string {
  const lines = [title, ''];
  const candidates = findings.flatMap((f) => f.candidates.map((c) => ({ of: f.symbol, ...c })));
  if (candidates.length === 0) return [...lines, `No similar existing functions found (min score ${minScore}).`].join('\n');
  for (const f of findings) {
    if (findings.length > 1) lines.push(`### \`${f.symbol.qualifiedName}\``, '');
    for (const c of f.candidates) {
      lines.push(`- \`${c.symbol.qualifiedName}\` at ${location(c.symbol)} — score ${c.score.toFixed(2)} (${c.reasons.join('; ')}); key \`${c.symbol.key}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}
