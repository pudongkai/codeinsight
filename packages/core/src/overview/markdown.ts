import { httpRoute, isHttpApi } from '../model/entry.js';
import { markdownCell as cell } from '../report/markdown.js';
import type { SymbolRef } from '../report/types.js';
import type { BoundaryIssue, EdgeSample, Feature, OverviewModule, OverviewReport } from './types.js';

function symbolText(s: SymbolRef): string {
  const route = isHttpApi(s.entry) ? httpRoute(s.entry) : '';
  return `\`${s.qualifiedName}\`${route ? ` (${route})` : ''} — \`${s.path}:${s.startLine}\``;
}

function sampleText(s: EdgeSample): string {
  return `\`${s.src.qualifiedName}\` → \`${s.dst.qualifiedName}\` (\`${s.path}:${s.line}\`)`;
}

function header(r: OverviewReport): string[] {
  const snap = r.snapshot.kind === 'working' ? `working tree (HEAD ${r.snapshot.commitSha.slice(0, 12)})` : `${r.ref} (${r.snapshot.commitSha.slice(0, 12)})`;
  const s = r.stats;
  const lines = [
    `# ${r.system?.title ?? 'CodeInsight 系统概览'}`,
    '',
    `- 仓库：\`${r.repo}\``,
    `- 版本：${snap}；生成时间：${new Date(r.generatedAt).toISOString()}`,
    `- 规模：${s.files} 个文件（另有 ${s.testFiles} 个测试文件），${s.modules} 个模块，${s.functions} 个函数，${s.httpApis} 个 HTTP 接口，${s.models} 个数据模型`,
    r.llm ? `- AI 说明：${r.llm.provider}（${r.llm.model}）` : '- AI 说明：无（只有结构部分）',
    '',
  ];
  if (r.system) lines.push('## 系统简介', '', r.system.summary, '');
  return lines;
}

function moduleTable(r: OverviewReport, shown: number, omittedNote: (n: number) => string): string[] {
  const out = ['## 模块', '', '| 名称 | id | 职责 | 规模 | 接口 | 依赖 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const m of r.modules.slice(0, shown)) {
    const deps = r.moduleEdges.filter((e) => e.from === m.id && e.weight > 0).map((e) => e.to);
    out.push(`| ${cell(m.name)} | \`${m.id}\` | ${cell(m.responsibility ?? '')} | ${m.size} | ${m.httpApis} | ${cell(deps.join(', '))} |`);
  }
  out.push('');
  if (shown < r.modules.length) out.push(`> ${omittedNote(r.modules.length - shown)}`, '');
  return out;
}

function externalLines(r: OverviewReport): string[] {
  if (r.external.length === 0) return [];
  return ['## 外部依赖', '', ...r.external.map((e) => `- **${e.category}**：${e.libs.join(', ')}（${e.modules.map((m) => `\`${m}\``).join(', ')}）`), ''];
}

function featureLines(features: Feature[], heading: string): string[] {
  if (features.length === 0) return [];
  const out = [heading, ''];
  for (const f of features) {
    out.push(`- **${f.name}**（\`${f.module}\`）${f.description ? `：${f.description}` : ''}`);
    for (const e of f.entries) out.push(`  - ${e.method || e.path ? `${[e.method, e.path].filter(Boolean).join(' ')} ` : `${e.kind} `}\`${e.symbol.qualifiedName}\``);
  }
  out.push('');
  return out;
}

function issueLines(issues: BoundaryIssue[], heading: string): string[] {
  if (issues.length === 0) return [];
  const out = [heading, ''];
  for (const i of issues) {
    out.push(`- [${i.severity}] ${i.kind}：${i.message}`);
    for (const s of i.samples.slice(0, 3)) out.push(`  - ${sampleText(s)}`);
  }
  out.push('');
  return out;
}

function warningLines(r: OverviewReport): string[] {
  if (r.warnings.length === 0) return [];
  return ['## 提示', '', ...r.warnings.map((w) => `- **${w.code}**：${w.message.split('\n')[0]}`), ''];
}

export interface OverviewMarkdownOptions {
  /** 字数上限：超出时先减少模块表列出的模块数，仍超出再按行截断 */
  maxChars?: number;
  /** 模块表没列全时的说明，n 为未列出的模块数 */
  omittedModulesNote?: (n: number) => string;
}

const defaultOmittedNote = (n: number) => `其余 ${n} 个模块未列出`;

function renderOverview(r: OverviewReport, shown: number, omittedNote: (n: number) => string): string {
  return [
    ...header(r), ...moduleTable(r, shown, omittedNote), ...externalLines(r),
    ...featureLines(r.features, '## 功能'), ...issueLines(r.issues, '## 边界问题'), ...warningLines(r),
  ].join('\n');
}

/** 在上限内能列出的最多模块数（二分），其他部分保持完整 */
function fitModules(r: OverviewReport, max: number, note: (n: number) => string): number {
  let lo = 0;
  let hi = r.modules.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (renderOverview(r, mid, note).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 整份概览转 Markdown（CLI、MCP get_overview 共用）。给出 maxChars 且超出时，优先缩减模块表（功能、边界问题等保持完整，
 * 单个模块的详情可另外查），仍超出时在行边界截断。
 */
export function overviewMarkdown(r: OverviewReport, opts: OverviewMarkdownOptions = {}): string {
  const note = opts.omittedModulesNote ?? defaultOmittedNote;
  const full = renderOverview(r, r.modules.length, note);
  if (opts.maxChars === undefined || full.length <= opts.maxChars) return full;
  const text = renderOverview(r, fitModules(r, opts.maxChars, note), note);
  return truncateAtLine(text, opts.maxChars);
}

/** 超过 max 字符时在行边界截断并注明总长度，结果不超过 max */
export function truncateAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = `\n\n> 内容过长已截断（共 ${text.length} 字符）。`;
  const cut = text.lastIndexOf('\n', Math.max(0, max - note.length));
  return `${text.slice(0, Math.max(0, cut))}${note}`;
}

/** 按模块 id 或名称找模块，id 优先 */
export function findModule(r: OverviewReport, idOrName: string): OverviewModule | undefined {
  return r.modules.find((m) => m.id === idOrName) ?? r.modules.find((m) => m.name === idOrName);
}

function moduleFacts(m: OverviewModule): string[] {
  const out: string[] = [];
  if (m.interfaces.length > 0) {
    out.push('### 对外接口', '', ...m.interfaces.map((i) => `- ${symbolText(i.symbol)}${i.fromModules.length ? `，被 ${i.fromModules.join(', ')} 使用` : ''}${i.summary ? `：${i.summary}` : ''}`), '');
  }
  if (m.models.length > 0) out.push('### 数据模型', '', ...m.models.map((x) => `- ${symbolText(x.symbol)}${x.summary ? `：${x.summary}` : ''}`), '');
  if (m.external.length > 0) out.push('### 外部依赖', '', ...m.external.map((e) => `- **${e.category}**：${e.libs.join(', ')}`), '');
  if (m.envVars.length > 0) out.push('### 环境变量', '', ...m.envVars.map((e) => `- \`${e.name}\`（${e.files.map((f) => `\`${f}\``).join(', ')}）`), '');
  return out;
}

function moduleDeps(r: OverviewReport, id: string): string[] {
  const edges = r.moduleEdges.filter((e) => e.from === id || e.to === id);
  if (edges.length === 0) return [];
  const out = ['### 依赖', ''];
  for (const e of edges) {
    out.push(`- \`${e.from}\` → \`${e.to}\`：${e.weight} 处调用或引用（${e.kinds.join(', ')}）${e.inCycle ? '，在循环依赖里' : ''}`);
    for (const s of e.samples) out.push(`  - ${sampleText(s)}`);
  }
  out.push('');
  return out;
}

/** 单个模块的详情 Markdown（MCP get_overview 带 module、问答 get_module 共用）；找不到时返回 undefined */
export function moduleMarkdown(r: OverviewReport, idOrName: string): string | undefined {
  const m = findModule(r, idOrName);
  if (!m) return undefined;
  return [
    `## ${m.name}（\`${m.id}\`）`,
    '',
    ...(m.responsibility ? [m.responsibility, ''] : []),
    `- 目录：${m.dirs.map((d) => `\`${d}\``).join(', ')}；${m.files.length} 个文件，规模 ${m.size}，${m.lines} 行`,
    '',
    ...moduleFacts(m),
    ...moduleDeps(r, m.id),
    ...featureLines(r.features.filter((f) => f.module === m.id), '### 功能'),
    ...issueLines(r.issues.filter((i) => i.modules.includes(m.id)), '### 边界问题'),
  ].join('\n');
}
