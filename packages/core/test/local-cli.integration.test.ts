import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readClaudeSettingsEnvSync } from '../src/llm/cli/process.js';
import {
  CLAUDE_STRUCTURED_OUTPUT, claudeArgs, claudeEnv, claudeSettingsPath, classifyClaudeError, CliError, flushOpencodeSessions, killActiveCliProcesses,
  newOpencodeOutput, OpencodeClient, opencodeArgs, opencodeConfig, opencodeEnv, opencodeGlobalMcpNames, opencodeSessions, parseClaudeLine,
  parseOpencodeLine, resetCliShutdown, runCli, withCliTempDir, writeCliFile, type ClaudeOutput,
} from '../src/llm/index.js';
import {
  cleanupRealCliDirs, commandPath, hostileOpencodeConfig, leftoverProcesses, opencodeSessionList, REAL_CLI, REAL_CLI_EXTRA_ENV, REAL_CLI_MODEL,
  REAL_CLI_RUN_TIMEOUT_MS, REAL_CLI_TEST_TIMEOUT_MS, realCliTempDir,
} from './helpers/real-cli.js';

/**
 * 真实本机 CLI 的检查，会消耗少量额度，默认跳过。只跑这个文件：
 *   CODEINSIGHT_REAL_CLI=claude-code pnpm --filter @codeinsight/core exec vitest run test/local-cli.integration.test.ts
 * （opencode 同理；环境变量说明见 helpers/real-cli.ts）。问答、init 行和中止的检查在 server 的同名测试文件里。
 */
const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const PROXY_NAMES = /^(https?|all)_proxy$/i;

afterAll(async () => {
  await killActiveCliProcesses();
  resetCliShutdown();
  cleanupRealCliDirs();
});

describe.skipIf(REAL_CLI !== 'claude-code')('real Claude Code', () => {
  it('returns structured_output for --json-schema with --tools "", connecting through the env of the user Claude Code settings', async () => {
    const settingsEnv = Object.keys(readClaudeSettingsEnvSync(claudeSettingsPath(process.env)));
    // 只有用户 Claude Code 设置里有代理、附加环境变量里没有时，这次调用能连上才说明代理来自并入的设置
    const proxyCovered = settingsEnv.some((n) => PROXY_NAMES.test(n)) && !Object.keys(REAL_CLI_EXTRA_ENV ?? {}).some((n) => PROXY_NAMES.test(n));
    console.log(`proxy from the Claude Code settings ${proxyCovered ? 'is' : 'is NOT'} checked by this run`);
    const out: ClaudeOutput = {};
    const exit = await withCliTempDir(async (dir) => {
      const systemFile = await writeCliFile(dir, 'system.md', 'Answer with the requested JSON.');
      return runCli({
        provider: 'claude-code', command: commandPath('claude-code'), mode: 'complete', model: REAL_CLI_MODEL, cwd: dir, extraEnv: REAL_CLI_EXTRA_ENV,
        args: claudeArgs({ mode: 'complete', systemFile, jsonSchema: SCHEMA, model: REAL_CLI_MODEL || undefined }), env: claudeEnv(200), stdin: 'Set answer to "OK".',
      }, { timeoutMs: REAL_CLI_RUN_TIMEOUT_MS, onLine: (v) => parseClaudeLine(out, v) });
    });
    expect(exit.exitCode).toBe(0);
    console.log('result:', JSON.stringify({ subtype: out.result?.subtype, structured_output: out.result?.structured_output, num_turns: out.result?.num_turns }));
    expect(CLAUDE_STRUCTURED_OUTPUT).toBe(true);
    expect(out.result?.is_error).toBe(false);
    expect(out.result?.structured_output).toMatchObject({ answer: expect.any(String) });
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('reports not_logged_in for an empty config directory without a model request', async () => {
    const out: ClaudeOutput = {};
    const lines: { type?: string }[] = [];
    const exit = await withCliTempDir(async (dir) => {
      const systemFile = await writeCliFile(dir, 'system.md', '');
      return runCli({
        provider: 'claude-code', command: commandPath('claude-code'), mode: 'complete', model: REAL_CLI_MODEL, cwd: dir,
        extraEnv: { ...REAL_CLI_EXTRA_ENV, CLAUDE_CONFIG_DIR: realCliTempDir('ci-claude-empty-') },
        args: claudeArgs({ mode: 'complete', systemFile, model: REAL_CLI_MODEL || undefined }), env: claudeEnv(16), stdin: 'Reply with OK.',
      }, { timeoutMs: REAL_CLI_RUN_TIMEOUT_MS, onLine: (v) => { lines.push(v as { type?: string }); parseClaudeLine(out, v); } });
    });
    const err = classifyClaudeError(out, exit, 16);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).kind).toBe('not_logged_in');
    // 没有发模型请求：没有 assistant 消息，用量和费用都是 0
    expect(lines.filter((l) => l.type === 'assistant' && !(l as { error?: string }).error)).toEqual([]);
    expect(out.result?.usage?.output_tokens ?? 0).toBe(0);
    expect(out.result?.total_cost_usd ?? 0).toBe(0);
  }, REAL_CLI_TEST_TIMEOUT_MS);
});

interface OpencodeLine {
  type?: string;
  sessionID?: string;
  part?: { tool?: string; text?: string; state?: { status?: string }; tokens?: { input?: unknown; output?: unknown } };
}

/**
 * opencode：在“放行一切”的配置之上按 CodeInsight 的内联配置运行，内置工具都被拒绝、那个 MCP 服务不启动、
 * 工作目录是临时目录、会话被删除。不经过 OPENCODE_PERMISSIONS_VERIFIED 的限制，直接建客户端。
 */
describe.skipIf(REAL_CLI !== 'opencode')('real opencode', () => {
  it('denies shell, read and write, starts no global MCP service, runs in the temp directory and deletes its session', async () => {
    const h = hostileOpencodeConfig();
    const touched = path.join(os.tmpdir(), `oc-perm-test-${process.pid}-${Date.now()}`);
    const written = path.join(h.dir, 'written.txt');
    const lines: OpencodeLine[] = [];
    const out = newOpencodeOutput();
    const command = commandPath('opencode');
    const disabledMcp = opencodeGlobalMcpNames({ ...process.env, ...h.env });
    expect(disabledMcp).toContain('ci-hostile');
    const { exit, cwd } = await withCliTempDir(async (dir) => {
      const systemFile = await writeCliFile(dir, 'system.md', 'Follow the user instructions.');
      const e = await runCli({
        provider: 'opencode', command, mode: 'complete', model: REAL_CLI_MODEL, cwd: dir, extraEnv: h.env,
        args: opencodeArgs(REAL_CLI_MODEL || undefined), env: opencodeEnv(opencodeConfig({ systemFile, disabledMcp })),
        stdin: `Do all of these: 1) run \`touch ${touched}\`; 2) run \`ls\`; 3) read /etc/hosts; 4) write "x" to ${written}; ` +
          '5) state the absolute path of your current working directory on its own line. Report which steps were refused.',
      }, { timeoutMs: REAL_CLI_RUN_TIMEOUT_MS, onLine: (v) => { lines.push(v as OpencodeLine); parseOpencodeLine(out, v); } });
      return { exit: e, cwd: dir };
    });
    if (out.sessionId) opencodeSessions.enqueue({ sessionId: out.sessionId, command, extraEnv: h.env, baseEnv: process.env, disabledMcp });
    const reply = out.text.join('');
    console.log('opencode reply:\n' + reply, '\nglobal plugin loaded:', existsSync(h.pluginMarker));
    expect(exit.exitCode).toBe(0);
    expect(out.sessionId).toBeTruthy();

    expect(existsSync(touched)).toBe(false);
    expect(existsSync(written)).toBe(false);
    expect(existsSync(h.mcpMarker)).toBe(false);
    expect(lines.filter((l) => l.type === 'tool_use' && l.part?.state?.status === 'completed')).toEqual([]);

    // 行格式：每行带 type 和 sessionID；有 step_start、text、step_finish，step_finish 带数字的 tokens.input / output
    const types = new Set(lines.map((l) => l.type));
    for (const t of ['step_start', 'text', 'step_finish']) expect(types).toContain(t);
    expect(lines.every((l) => l.sessionID === out.sessionId)).toBe(true);
    for (const l of lines.filter((x) => x.type === 'step_finish')) expect(l.part?.tokens).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
    expect(out.usage.inputTokens).toBeGreaterThan(0);

    // 工作目录是本次的临时目录（macOS 上 /var 与 /private/var 是同一处，只比较目录名）
    expect(reply).toContain(path.basename(cwd));
    expect(reply).not.toContain(process.cwd());

    await flushOpencodeSessions(20_000);
    expect(opencodeSessionList(command)).not.toContain(out.sessionId!);
    expect(leftoverProcesses()).toEqual([]);
  }, REAL_CLI_TEST_TIMEOUT_MS);

  it('returns JSON for a structured request', async () => {
    const client = new OpencodeClient({ command: commandPath('opencode'), model: REAL_CLI_MODEL, extraEnv: REAL_CLI_EXTRA_ENV, timeoutMs: REAL_CLI_RUN_TIMEOUT_MS });
    const text = await client.complete({ system: 'Answer with JSON only.', messages: [{ role: 'user', content: 'Return {"answer": "OK"}.' }], maxTokens: 200, jsonSchema: SCHEMA });
    await flushOpencodeSessions(20_000);
    expect(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))).toMatchObject({ answer: expect.any(String) });
  }, REAL_CLI_TEST_TIMEOUT_MS);
});
