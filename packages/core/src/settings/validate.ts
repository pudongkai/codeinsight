import path from 'node:path';

/**
 * 模型名、命令路径、附加环境变量的校验，设置文件和设置接口共用。
 * 返回不合格的原因（不含值本身），合格时返回 undefined。
 */

export const MAX_MODEL_CHARS = 200;
export const MAX_COMMAND_CHARS = 1024;
export const MAX_EXTRA_ENV_ENTRIES = 32;
export const MAX_EXTRA_ENV_VALUE_CHARS = 4096;

/** 可打印字符、不含空白；不能以 `-` 开头：模型名会作为 CLI 参数传入，不能被当成选项 */
const MODEL_PATTERN = /^[^\s\p{C}-][^\s\p{C}]*$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function modelProblem(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '') return 'expected a non-empty string';
  if (v.length > MAX_MODEL_CHARS) return `expected at most ${MAX_MODEL_CHARS} characters`;
  if (!MODEL_PATTERN.test(v)) return 'expected printable characters without whitespace, not starting with -';
  return undefined;
}

/**
 * 命令路径：非空、不超过上限、不含换行和 NUL。
 * pathOrName 为 true 时（接口保存）还要求是绝对路径或不含路径分隔符的命令名，不接受相对路径。
 */
export function commandProblem(v: unknown, opts: { pathOrName?: boolean } = {}): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') return 'expected a non-empty string';
  if (v.length > MAX_COMMAND_CHARS) return `expected at most ${MAX_COMMAND_CHARS} characters`;
  if (/[\r\n\0]/.test(v)) return 'expected no line breaks or NUL characters';
  if (opts.pathOrName && !path.isAbsolute(v) && /[/\\]/.test(v)) return 'expected an absolute path or a command name';
  return undefined;
}

/** PATH 不能改：找命令和子进程环境都依赖它 */
export function envNameProblem(name: string): string | undefined {
  if (!ENV_NAME_PATTERN.test(name)) return 'expected a name of letters, digits and _, not starting with a digit';
  if (name.toUpperCase() === 'PATH') return 'PATH cannot be set here';
  return undefined;
}

export function envValueProblem(v: unknown): string | undefined {
  if (typeof v !== 'string') return 'expected a string';
  if (v.length > MAX_EXTRA_ENV_VALUE_CHARS) return `expected at most ${MAX_EXTRA_ENV_VALUE_CHARS} characters`;
  if (v.includes('\0')) return 'expected no NUL characters';
  return undefined;
}
