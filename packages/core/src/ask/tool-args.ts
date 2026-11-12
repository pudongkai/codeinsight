import type { AskToolError } from './events.js';

/** 工具执行失败：code 和简短说明会回给模型，说明里不能有绝对路径和异常原文 */
export class AskToolFailure extends Error {
  constructor(readonly code: AskToolError, message: string) {
    super(message);
  }
}

export type ToolArgs = Record<string, unknown>;

/** 参数必须是对象；模型给的参数不合法时作为 invalid_args 回给它 */
export function argsObject(input: unknown): ToolArgs {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new AskToolFailure('invalid_args', 'arguments must be a JSON object');
  return input as ToolArgs;
}

export function optString(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AskToolFailure('invalid_args', `\`${key}\` must be a string`);
  return v;
}

export function reqString(args: ToolArgs, key: string): string {
  const v = optString(args, key);
  if (v === undefined || v.trim() === '') throw new AskToolFailure('invalid_args', `\`${key}\` is required`);
  return v;
}

/** 整数参数：不传时用 def，超过 max 时取 max（上限是给模型的提示，不必让它重试） */
export function optInt(args: ToolArgs, key: string, range: { min: number; max: number; def: number }): number {
  const v = args[key];
  if (v === undefined || v === null) return range.def;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < range.min) {
    throw new AskToolFailure('invalid_args', `\`${key}\` must be an integer >= ${range.min}`);
  }
  return Math.min(n, range.max);
}

export function optBool(args: ToolArgs, key: string, def: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw new AskToolFailure('invalid_args', `\`${key}\` must be true or false`);
  return v;
}

export function reqEnum<T extends string>(args: ToolArgs, key: string, values: readonly T[]): T {
  const v = args[key];
  if (typeof v !== 'string' || !values.includes(v as T)) throw new AskToolFailure('invalid_args', `\`${key}\` must be one of ${values.join(', ')}`);
  return v as T;
}
