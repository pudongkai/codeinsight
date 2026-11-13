#!/usr/bin/env node
// 假的 claude 命令（问答 + 真实 MCP）：读 --mcp-config 里的 codeinsight 服务，用 SDK 的 Client 以 stdio 连上，
// 依次调用 search_symbols（refund）和 read_source（搜到的 refund），把真实结果写成 stream-json 的 tool_use / tool_result 行，
// 再输出回答和 result 行。FAKE_CLI_SCENARIO=mcp-hang 时调用完工具后停住（MCP 服务保持运行），用于检查中止时一起结束。
// 每次运行把 pid、MCP 服务的 pid 和 argv 追加一行 JSON 到 FAKE_CLI_RECORD。
// 测试连接用到的 `--version`、`auth status --json` 和不带 --mcp-config 的单次调用（-p --output-format json）也能应答，
// 网页 e2e 用它走通“测试连接 → 保存 → 问答”。
import { appendFileSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const PREFIX = 'mcp__codeinsight__';

try {
  readFileSync(0, 'utf8');
} catch {
  // 没有 stdin
}

/** 问答：连上 codeinsight 的 MCP 服务，调用工具后输出回答 */
async function askWithMcp() {
  const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  const server = config.mcpServers.codeinsight;
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: process.env, stderr: 'ignore' });
  const client = new Client({ name: 'fake-claude', version: '0.0.0' });
  await client.connect(transport);
  if (process.env.FAKE_CLI_RECORD) appendFileSync(process.env.FAKE_CLI_RECORD, JSON.stringify({ pid: process.pid, mcpPid: transport.pid, argv: args }) + '\n');

  out({ type: 'system', subtype: 'init', model: 'claude-fake-1', tools: (await client.listTools()).tools.map((t) => PREFIX + t.name), mcp_servers: [{ name: 'codeinsight', status: 'connected' }] });

  async function call(id, name, input) {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: PREFIX + name, input }] } });
    const r = await client.callTool({ name, arguments: input });
    const text = r.content.map((c) => c.text).join('\n');
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.content, is_error: r.isError === true }] } });
    return text;
  }

  const found = await call('tu_1', 'search_symbols', { query: 'refund' });
  const refundId = /^(\S+) function refund @ app\/orders\/service\.py:/m.exec(found)?.[1];
  await call('tu_2', 'read_source', { id: refundId });
  if (process.env.FAKE_CLI_SCENARIO === 'mcp-hang') {
    setInterval(() => undefined, 1000);
  } else {
    const answer = '退款由 orders 的 refund 处理。';
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: answer, num_turns: 3, total_cost_usd: 0.002, usage: { input_tokens: 30, output_tokens: 9 } });
    await client.close();
  }
}

if (args[0] === '--version') {
  process.stdout.write('2.1.318 (Claude Code)\n');
} else if (args[0] === 'auth') {
  out({ loggedIn: true, authMethod: 'claude.ai' });
} else if (!args.includes('--mcp-config')) {
  out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', num_turns: 1, usage: { input_tokens: 5, output_tokens: 1 } });
} else {
  await askWithMcp();
}
