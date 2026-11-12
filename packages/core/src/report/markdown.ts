import type { DuplicateFinding, EdgeChange, FileChange, IntentFinding, ModuleChange, ReviewReport, SymbolChange, Warning } from './types.js';

/** 边变化超过这个数时只列出前面部分，避免报告过长 */
const MAX_EDGE_LINES = 200;

const CHANGE_LABEL: Record<SymbolChange['change'], string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  signature_changed: 'signature changed',
  moved: 'moved',
};

/** 表格单元格里的 `|` 和换行会打乱表格 */
export function markdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function header(r: ReviewReport): string[] {
  const head = r.head.working ? `working tree (HEAD ${r.head.sha.slice(0, 12)})` : `${r.head.ref} (${r.head.sha.slice(0, 12)})`;
  const counts = new Map<string, number>();
  for (const s of r.modules.flatMap((m) => m.symbols)) counts.set(s.change, (counts.get(s.change) ?? 0) + 1);
  const summary = [...counts].map(([k, n]) => `${n} ${CHANGE_LABEL[k as SymbolChange['change']]}`).join(', ') || 'no symbol changes';
  return [
    '# CodeInsight review',
    '',
    `- Repo: \`${r.repo}\``,
    `- Base: ${r.base.ref} (${r.base.sha.slice(0, 12)})`,
    `- Head: ${head}`,
    `- Files changed: ${r.files.length}; symbols: ${summary}; edge changes: ${r.edgeChanges.length}`,
    '',
  ];
}

function warningLines(warnings: Warning[]): string[] {
  if (warnings.length === 0) return [];
  const unsupported = warnings.filter((w) => w.code === 'language_unsupported');
  const others = warnings.filter((w) => w.code !== 'language_unsupported');
  const lines = ['## Warnings', ''];
  for (const w of others) lines.push(`- **${w.code}**${w.side ? ` (${w.side})` : ''}: ${w.message.split('\n')[0]}`);
  if (unsupported.length > 0) {
    lines.push(`- **language_unsupported**: ${unsupported.length} file(s) listed as file-level changes only: ${unsupported.map((w) => `\`${w.path}\``).join(', ')}`);
  }
  lines.push('');
  return lines;
}

function symbolRow(s: SymbolChange): string {
  const change = s.change === 'moved' && s.movedFrom ? `moved from \`${markdownCell(s.movedFrom)}\`` : CHANGE_LABEL[s.change];
  const sig = s.displaySignatureBefore !== undefined ? `\`${markdownCell(s.displaySignatureBefore)}\` → \`${markdownCell(s.displaySignature)}\`` : s.displaySignature ? `\`${markdownCell(s.displaySignature)}\`` : '';
  const entry = s.entry ? `${s.entry.framework} ${s.entry.kind}` : '';
  const top = s.callers.topProd.map((c) => c.qualifiedName).join(', ');
  const callers = `${s.callers.prod} / ${s.callers.test}${top ? ` (${markdownCell(top)})` : ''}`;
  const impact = `${s.impact.prod} / ${s.impact.test}`;
  return `| ${change} | \`${markdownCell(s.qualifiedName)}\` | ${s.kind} | \`${s.path}:${s.startLine}\` | ${sig} | ${entry} | ${callers} | ${impact} |`;
}

function moduleLines(modules: ModuleChange[], impactDepth: number): string[] {
  if (modules.length === 0) return ['## Changes by module', '', 'No function-level changes.', ''];
  const lines = ['## Changes by module', ''];
  for (const m of modules) {
    lines.push(`### ${m.module}`, '');
    lines.push(`| Change | Symbol | Kind | Location | Signature | Entry | Callers prod / test | Impact (${impactDepth} levels) prod / test |`);
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of m.symbols) lines.push(symbolRow(s));
    lines.push('');
  }
  return lines;
}

function edgeLines(edges: EdgeChange[]): string[] {
  if (edges.length === 0) return [];
  const lines = ['## Edge changes', ''];
  for (const e of edges.slice(0, MAX_EDGE_LINES)) {
    lines.push(`- ${e.change === 'added' ? '+' : '-'} ${e.kind} \`${e.src.qualifiedName}\` → \`${e.dst.qualifiedName}\` (${e.dst.path})`);
  }
  if (edges.length > MAX_EDGE_LINES) lines.push(`- … ${edges.length - MAX_EDGE_LINES} more`);
  lines.push('');
  return lines;
}

/** 重复实现候选（审查报告和 `codeinsight similar --format md` 共用） */
export function duplicatesToMarkdown(findings: DuplicateFinding[], title = '## Possible duplicates'): string[] {
  if (findings.length === 0) return [];
  const lines = [title, '', '| Symbol | Similar to | Score | Reasons |', '| --- | --- | --- | --- |'];
  for (const f of findings) {
    for (const [i, c] of f.candidates.entries()) {
      const symbol = i === 0 ? `\`${markdownCell(f.symbol.qualifiedName)}\` (\`${f.symbol.path}:${f.symbol.startLine}\`)` : '';
      lines.push(`| ${symbol} | \`${markdownCell(c.symbol.qualifiedName)}\` (\`${c.symbol.path}:${c.symbol.startLine}\`) | ${c.score.toFixed(2)} | ${markdownCell(c.reasons.join('; '))} |`);
    }
  }
  lines.push('');
  return lines;
}

const VERDICT_ORDER: IntentFinding['verdict'][] = ['unmentioned', 'unclear', 'mentioned'];

function intentCheckLines(findings: IntentFinding[] | undefined): string[] {
  if (!findings) return [];
  if (findings.length === 0) return ['## Intent check', '', 'No groups returned.', ''];
  const lines = ['## Intent check', ''];
  for (const verdict of VERDICT_ORDER) {
    for (const f of findings.filter((x) => x.verdict === verdict)) {
      const symbols = f.symbols.map((s) => `\`${s.qualifiedName}\``).join(', ');
      lines.push(`- **${verdict}**: ${f.summary.replace(/\s*\n\s*/g, ' ')}${f.modules.length ? ` (${f.modules.join(', ')})` : ''}${symbols ? ` — ${symbols}` : ''}`);
    }
  }
  lines.push('');
  return lines;
}

function fileLines(files: FileChange[]): string[] {
  if (files.length === 0) return [];
  const lines = ['## Files', '', '| Status | Path | Language | +/- |', '| --- | --- | --- | --- |'];
  for (const f of files) {
    const p = f.oldPath ? `\`${f.oldPath}\` → \`${f.path}\`` : `\`${f.path}\``;
    lines.push(`| ${f.status} | ${p}${f.isTest ? ' (test)' : ''} | ${f.supportLevel === 'none' ? `${f.language} (unsupported)` : f.language} | +${f.additions} / -${f.deletions} |`);
  }
  lines.push('');
  return lines;
}

/** 审查报告转 Markdown（CLI `--format md` 和 MCP 共用） */
export function reportToMarkdown(r: ReviewReport): string {
  const impactDepth = r.modules[0]?.symbols[0]?.impact.depth ?? 2;
  const intent = r.intent ? ['## Intent', '', `Source: ${r.intent.source}`, '', ...r.intent.text.split('\n').map((l) => `> ${l}`), ''] : [];
  return [
    ...header(r),
    ...warningLines(r.warnings),
    ...intent,
    ...intentCheckLines(r.intentCheck),
    ...moduleLines(r.modules, impactDepth),
    ...duplicatesToMarkdown(r.duplicates),
    ...edgeLines(r.edgeChanges),
    ...fileLines(r.files),
  ].join('\n');
}
