import type { IntentFinding } from '../report/types.js';

/** prompt 或输出格式变化时加一，旧缓存随之失效 */
export const PROMPT_VERSION = 1;

export const SYSTEM_PROMPT = `You review a code change against its task description.
You get the task description and a structural summary of the change: changed symbols grouped by module
(change type, symbol key, signature, first docstring line) and the list of added files. Function bodies are not included.

Group the changed symbols by what the change does. For each group decide whether the task description covers it:
- "mentioned": the description states or clearly implies this change
- "unmentioned": the description does not cover this change
- "unclear": cannot tell from the description

Reply with JSON only, no prose and no code fences, in exactly this shape:
{"groups":[{"verdict":"mentioned","summary":"one sentence","symbols":["<symbol key>"],"modules":["<module>"]}]}

Rules: copy symbol keys and module names exactly as listed; put every listed symbol in exactly one group;
write "summary" in the language of the task description.`;

export function userPrompt(intentText: string, summary: string): string {
  return `# Task description\n\n${intentText.trim()}\n\n# Structural summary of the change\n\n${summary}\n`;
}

export function retryPrompt(reason: string): string {
  return `Your previous reply was rejected: ${reason}. Reply again with JSON only, in the shape given in the instructions.`;
}

/** 模型返回的一组，key 和模块尚未与改动清单核对 */
export interface RawGroup {
  verdict: IntentFinding['verdict'];
  summary: string;
  symbols: string[];
  modules: string[];
}

export type ParseResult = { ok: true; groups: RawGroup[] } | { ok: false; reason: string };

const VERDICTS = new Set(['mentioned', 'unmentioned', 'unclear']);

/** 去掉模型可能加上的 ```json 代码块包裹 */
function stripFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return m ? m[1]! : text.trim();
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function parseGroup(g: unknown, i: number): RawGroup | string {
  if (typeof g !== 'object' || g === null) return `groups[${i}] is not an object`;
  const o = g as Record<string, unknown>;
  if (typeof o.verdict !== 'string' || !VERDICTS.has(o.verdict)) return `groups[${i}].verdict must be mentioned, unmentioned or unclear`;
  if (typeof o.summary !== 'string' || o.summary.trim() === '') return `groups[${i}].summary must be a non-empty string`;
  if (!isStringArray(o.symbols)) return `groups[${i}].symbols must be an array of strings`;
  if (o.modules !== undefined && !isStringArray(o.modules)) return `groups[${i}].modules must be an array of strings`;
  return { verdict: o.verdict as RawGroup['verdict'], summary: o.summary.trim(), symbols: o.symbols, modules: (o.modules as string[] | undefined) ?? [] };
}

/** 按约定的 JSON 结构校验模型输出，任何一处不合格都整体判为不合格 */
export function parseIntentResponse(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    return { ok: false, reason: 'reply is not valid JSON' };
  }
  const groups = (json as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return { ok: false, reason: 'missing "groups" array' };
  const out: RawGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = parseGroup(groups[i], i);
    if (typeof g === 'string') return { ok: false, reason: g };
    out.push(g);
  }
  return { ok: true, groups: out };
}
