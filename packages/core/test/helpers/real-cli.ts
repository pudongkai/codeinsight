import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliCommand } from '../../src/llm/cli/command.js';
import type { CliLlmProvider } from '../../src/settings/types.js';

/**
 * 真实本机 CLI 集成测试（core、server 的 local-cli.integration.test.ts）共用的设置。
 * CODEINSIGHT_REAL_CLI=claude-code|opencode 开启；CODEINSIGHT_REAL_CLI_MODEL 指定模型（opencode 为 provider/model）；
 * CODEINSIGHT_REAL_CLI_ENV='name=value;name=value' 作为附加环境变量传给 CLI。
 */
export const REAL_CLI = realCliProvider(process.env.CODEINSIGHT_REAL_CLI);
export const REAL_CLI_MODEL = process.env.CODEINSIGHT_REAL_CLI_MODEL ?? '';
export const REAL_CLI_EXTRA_ENV = parseEnvList(process.env.CODEINSIGHT_REAL_CLI_ENV);
/** 测试超时：要比用例里给 CLI 的超时长，CLI 先结束时用例能拿到它的错误 */
export const REAL_CLI_TEST_TIMEOUT_MS = 300_000;
/** 用例里给 CLI 的超时 */
export const REAL_CLI_RUN_TIMEOUT_MS = 240_000;

/** 值写错时直接报错，不让整个文件悄悄跳过 */
function realCliProvider(value: string | undefined): CliLlmProvider | undefined {
  if (!value) return undefined;
  if (value === 'claude-code' || value === 'opencode') return value;
  throw new Error(`CODEINSIGHT_REAL_CLI must be claude-code or opencode, got ${JSON.stringify(value)}`);
}

export function parseEnvList(text: string | undefined): Record<string, string> | undefined {
  const pairs = (text ?? '').split(/[;\n]/).map((p) => p.trim()).filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as const);
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

export function commandPath(provider: CliLlmProvider): string {
  const r = resolveCliCommand(provider, undefined, process.env);
  if (!r.ok) throw r.error;
  return r.path;
}

const created: string[] = [];

/** 测试用的临时目录，cleanupRealCliDirs 时删除 */
export function realCliTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** 登记由别的函数建的临时目录 */
export function trackRealCliDir(dir: string): string {
  created.push(dir);
  return dir;
}

export function cleanupRealCliDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/**
 * 本次测试起的进程：命令行里带给定标记（如测试数据目录，对应 ask-tools 服务）的，
 * 以及在 CLI 临时目录里运行或带 `--title codeinsight` 的 claude / opencode
 */
export function leftoverProcesses(markers: string[] = []): string[] {
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return ps.split('\n').filter((l) =>
    markers.some((m) => l.includes(m)) || (/claude|opencode/.test(l) && (l.includes('codeinsight-cli-') || l.includes('--title codeinsight'))));
}

export interface HostileOpencodeConfig {
  dir: string;
  /** 附加环境变量：OPENCODE_CONFIG 指向这份配置 */
  env: Record<string, string>;
  /** 配置里的 MCP 服务启动时写这个文件 */
  mcpMarker: string;
  /** 配置里的插件加载时写这个文件 */
  pluginMarker: string;
}

/**
 * 模拟“放行一切”的用户全局配置：bash、read、edit 允许，带一个 MCP 服务和一个插件，
 * 通过 OPENCODE_CONFIG 叠加在用户全局配置上（用户的 provider 和登录仍可用）
 */
export function hostileOpencodeConfig(): HostileOpencodeConfig {
  const dir = realCliTempDir('ci-oc-hostile-');
  const mcpMarker = path.join(dir, 'mcp-started');
  const pluginMarker = path.join(dir, 'plugin-loaded');
  const plugin = path.join(dir, 'plugin.js');
  writeFileSync(plugin, `import { writeFileSync } from 'node:fs';\nexport const Marker = async () => { writeFileSync(${JSON.stringify(pluginMarker)}, 'x'); return {}; };\n`);
  const file = path.join(dir, 'opencode.json');
  writeFileSync(file, JSON.stringify({
    permission: { bash: 'allow', read: 'allow', edit: 'allow' },
    mcp: { 'ci-hostile': { type: 'local', command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(mcpMarker)}, 'x')`], enabled: true } },
    plugin: [`file://${plugin}`],
  }));
  return { dir, env: { ...REAL_CLI_EXTRA_ENV, OPENCODE_CONFIG: file }, mcpMarker, pluginMarker };
}

/** opencode 当前（非 git 目录对应的全局项目）的会话列表 JSON */
export function opencodeSessionList(command: string): string {
  return execFileSync(command, ['session', 'list', '--standalone', '--format', 'json'], { encoding: 'utf8', cwd: os.tmpdir() });
}
