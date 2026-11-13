import { isStringArray, parseJsonReply } from '../llm/ask-json.js';
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

const STRING_LIST = { type: 'array', items: { type: 'string' } };

/** 回复的 JSON Schema，和 parseIntentResponse 对应 */
export const INTENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['mentioned', 'unmentioned', 'unclear'] }, summary: { type: 'string' }, symbols: STRING_LIST, modules: STRING_LIST },
        required: ['verdict', 'summary', 'symbols'],
      },
    },
  },
  required: ['groups'],
};

export function userPrompt(intentText: string, summary: string): string {
  return `# Task description\n\n${intentText.trim()}\n\n# Structural summary of the change\n\n${summary}\n`;
}

export { jsonRetryPrompt as retryPrompt } from '../llm/ask-json.js';

/** 模型返回的一组，key 和模块尚未与改动清单核对 */
export interface RawGroup {
  verdict: IntentFinding['verdict'];
  summary: string;
  symbols: string[];
  modules: string[];
}

export type ParseResult = { ok: true; groups: RawGroup[] } | { ok: false; reason: string };

const VERDICTS = new Set(['mentioned', 'unmentioned', 'unclear']);

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
  const parsed = parseJsonReply(text);
  if (!parsed.ok) return parsed;
  const groups = (parsed.value as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return { ok: false, reason: 'missing "groups" array' };
  const out: RawGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = parseGroup(groups[i], i);
    if (typeof g === 'string') return { ok: false, reason: g };
    out.push(g);
  }
  return { ok: true, groups: out };
}
