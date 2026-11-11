import type { SymbolChangeKind } from '../report/types.js';

/** 结构摘要里的一个改动符号；只有结构信息，不含函数体 */
export interface IntentItem {
  key: string;
  module: string;
  change: SymbolChangeKind;
  displaySignature: string;
  /** docstring 首行，没有时为 null */
  docLine: string | null;
}

/** 结构摘要超过这个 token 数时按模块截断 */
export const SUMMARY_TOKEN_BUDGET = 8000;
/** 单行 docstring 最多保留的字符数 */
const DOC_LINE_CHARS = 160;

export interface StructureSummary {
  text: string;
  /** 摘要里实际包含的符号 key */
  includedKeys: Set<string>;
  /** 因超出预算没有放进摘要的模块（含只放进一部分的模块） */
  truncatedModules: string[];
  omittedSymbols: number;
}

/**
 * 粗略估计 token 数：ASCII 约 4 个字符一个 token，其余字符（如中文）按一个字符一个 token 算，
 * 宁可高估，保证发送的内容不超出预算。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

export function docFirstLine(doc: string | null): string | null {
  const line = doc?.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > DOC_LINE_CHARS ? line.slice(0, DOC_LINE_CHARS) + '…' : line;
}

function itemLine(i: IntentItem): string {
  const sig = i.displaySignature ? ` ${i.displaySignature}` : '';
  return `- [${i.change}] ${i.key}${sig}${i.docLine ? ` — ${i.docLine}` : ''}`;
}

function groupItems(items: IntentItem[]): Map<string, IntentItem[]> {
  const out = new Map<string, IntentItem[]>();
  for (const i of [...items].sort((a, b) => a.module.localeCompare(b.module) || a.key.localeCompare(b.key))) {
    const list = out.get(i.module);
    if (list) list.push(i);
    else out.set(i.module, [i]);
  }
  return out;
}

/**
 * 结构摘要：按模块列出改动符号（change 类型、key、签名、docstring 首行），再列新增文件。
 * 超出预算时整模块放不下就停下，后面的模块都不发送；第一个模块就放不下时放进能放下的部分。
 */
export function buildStructureSummary(items: IntentItem[], addedFiles: string[], budget = SUMMARY_TOKEN_BUDGET): StructureSummary {
  const filesBlock = addedFiles.length > 0 ? ['', '## Added files', ...addedFiles.map((f) => `- ${f}`)].join('\n') : '';
  let used = estimateTokens(filesBlock);
  const lines: string[] = [];
  const includedKeys = new Set<string>();
  const truncatedModules: string[] = [];
  let omittedSymbols = 0;
  for (const [module, list] of groupItems(items)) {
    const block = [`## ${module}`, ...list.map(itemLine)];
    const cost = estimateTokens(block.join('\n') + '\n');
    if (truncatedModules.length === 0 && used + cost <= budget) {
      lines.push(...block);
      for (const i of list) includedKeys.add(i.key);
      used += cost;
      continue;
    }
    const partial = truncatedModules.length === 0 && includedKeys.size === 0 ? fitPartial(module, list, budget - used) : [];
    if (partial.length > 0) {
      lines.push(`## ${module}`, ...partial.map(itemLine));
      for (const i of partial) includedKeys.add(i.key);
    }
    truncatedModules.push(module);
    omittedSymbols += list.length - partial.length;
  }
  return { text: lines.join('\n') + filesBlock, includedKeys, truncatedModules, omittedSymbols };
}

function fitPartial(module: string, list: IntentItem[], remaining: number): IntentItem[] {
  let used = estimateTokens(`## ${module}\n`);
  const out: IntentItem[] = [];
  for (const i of list) {
    const cost = estimateTokens(itemLine(i) + '\n');
    if (used + cost > remaining) break;
    out.push(i);
    used += cost;
  }
  return out;
}
