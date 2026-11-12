// 假 LLM 服务：同时实现 anthropic /v1/messages 和 openai-compatible /chat/completions（非流式和流式、文本和工具调用），
// 回复由测试给的函数或脚本决定，记录每次请求。core / server / cli 的 vitest 和 web 的 Playwright 按相对路径导入。
import { createServer } from 'node:http';

function protocolOf(url) {
  if (url.endsWith('/v1/messages')) return 'anthropic';
  if (url.endsWith('/chat/completions')) return 'openai';
  return undefined;
}

function normalize(reply) {
  return typeof reply === 'string' ? { text: reply } : reply;
}

function successBody(protocol, r) {
  if (protocol === 'anthropic') {
    return { content: [{ type: 'text', text: r.text }], stop_reason: r.truncated ? 'max_tokens' : 'end_turn' };
  }
  const calls = (r.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: toolArgs(c) } }));
  const message = { role: 'assistant', content: r.text ?? null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  return { choices: [{ message, finish_reason: r.truncated ? 'length' : calls.length > 0 ? 'tool_calls' : 'stop' }] };
}

function send(res, status, headers, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** 工具调用参数原文：rawArgs 给出时原样使用（模拟不完整的 JSON），否则为 input 的 JSON */
function toolArgs(call) {
  return call.rawArgs ?? JSON.stringify(call.input ?? {});
}

/** 把字符串切成每段 n 个字符（n 为 0 或不传时不切） */
function pieces(text, n) {
  if (!n || text.length <= n) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

function anthropicStop(r) {
  if (r.truncated) return 'max_tokens';
  return (r.toolCalls ?? []).length > 0 ? 'tool_use' : 'end_turn';
}

/** anthropic 流式事件：message_start → 文字块 → 每个工具调用一个 tool_use 块 → message_delta → message_stop */
function anthropicEvents(r) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [ev('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } })];
  let index = 0;
  if (r.text) {
    out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }));
    for (const t of pieces(r.text, r.deltaChars ?? 4)) out.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: t } }));
    out.push(ev('content_block_stop', { index }));
    index++;
  }
  (r.toolCalls ?? []).forEach((c, i) => {
    out.push(ev('content_block_start', { index, content_block: { type: 'tool_use', id: c.id ?? `toolu_${i}`, name: c.name, input: {} } }));
    for (const a of pieces(toolArgs(c), r.wholeToolCalls ? 0 : 7)) out.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: a } }));
    out.push(ev('content_block_stop', { index }));
    index++;
  });
  out.push(ev('message_delta', { delta: { stop_reason: anthropicStop(r) }, usage: { output_tokens: 5 } }));
  out.push(ev('message_stop', {}));
  return out;
}

function openAiFinish(r) {
  if (r.truncated) return 'length';
  return (r.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop';
}

/** 工具调用分片：第一片带 id 和 name，参数分多片；wholeToolCalls 时一次给出完整调用 */
function openAiToolChunks(r) {
  const out = [];
  (r.toolCalls ?? []).forEach((c, index) => {
    const id = c.id ?? `call_${index}`;
    if (r.wholeToolCalls) {
      out.push([{ index, id, type: 'function', function: { name: c.name, arguments: toolArgs(c) } }]);
      return;
    }
    out.push([{ index, id, type: 'function', function: { name: c.name, arguments: '' } }]);
    for (const a of pieces(toolArgs(c), 7)) out.push([{ index, function: { arguments: a } }]);
  });
  // noIndex：模拟分片不带 index 的服务
  if (r.noIndex) for (const calls of out) for (const c of calls) delete c.index;
  return out;
}

/** openai 流式 data 行：文字分片 → 工具调用分片 → finish_reason → usage（noUsage 时不给）→ [DONE] */
function openAiEvents(r) {
  const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const choice = (delta, finish = null) => data({ choices: [{ index: 0, delta, finish_reason: finish }] });
  const out = [choice({ role: 'assistant', content: '' })];
  if (r.text) for (const t of pieces(r.text, r.deltaChars ?? 4)) out.push(choice({ content: t }));
  for (const calls of openAiToolChunks(r)) out.push(choice({ tool_calls: calls }));
  out.push(choice({}, openAiFinish(r)));
  if (!r.noUsage) out.push(data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  out.push('data: [DONE]\n\n');
  return out;
}

/** 按 chunkChars 重新切分（模拟跨 chunk 的半行），crlf 时换行用 \r\n；每段之间等 delayMs；hang 时写到结束标记之前、不结束 */
async function writeStream(res, record, protocol, r) {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...(r.headers ?? {}) });
  const events = protocol === 'anthropic' ? anthropicEvents(r) : openAiEvents(r);
  // hang：写到结束标记之前就停住（anthropic 去掉 message_delta、message_stop；openai 去掉 finish、usage、[DONE]），不结束响应
  const tail = protocol === 'anthropic' ? 2 : r.noUsage ? 2 : 3;
  let text = (r.hang ? events.slice(0, -tail) : events).join('');
  if (r.crlf) text = text.replace(/\n/g, '\r\n');
  if (r.comments) text = `: keep-alive\n\n${text}`;
  for (const part of pieces(text, r.chunkChars ?? 0)) {
    if (record.aborted) return;
    res.write(part);
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
  }
  if (!r.hang) res.end();
}

async function respond(res, record, reply) {
  const r = normalize(reply);
  const protocol = record.protocol;
  if (r.status !== undefined && r.status !== 200) {
    send(res, r.status, r.headers ?? {}, r.body ?? { error: { type: r.errorType ?? 'fake_error', message: 'fake failure' } });
    return;
  }
  // json：不理会 stream: true、直接返回完整 JSON 的服务
  if (record.body.stream === true && !r.json) return writeStream(res, record, protocol, r);
  send(res, 200, r.headers ?? {}, successBody(protocol, r));
}

/**
 * 启动假 LLM 服务。opts.reply(req) 按请求内容返回回复；opts.script 按顺序返回（用完后重复最后一个）；都没有时回复 "{}"。
 */
export async function startFakeLlm(opts = {}) {
  const requests = [];
  let script = opts.script ? [...opts.script] : undefined;
  const pick = (req) => {
    if (opts.reply) return opts.reply(req);
    if (script && script.length > 0) return script.length > 1 ? script.shift() : script[0];
    return '{}';
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c.toString()));
    req.on('end', async () => {
      const protocol = protocolOf(req.url ?? '');
      if (!protocol) return send(res, 404, {}, { error: { type: 'not_found' } });
      const record = { protocol, url: req.url, headers: req.headers, body: JSON.parse(raw || '{}'), at: Date.now(), index: requests.length, aborted: false };
      requests.push(record);
      res.on('close', () => {
        if (!res.writableFinished) record.aborted = true;
      });
      try {
        await respond(res, record, await pick(record));
      } catch (err) {
        send(res, 500, {}, { error: { type: 'fake_server_error', message: String(err) } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    /** 换一份回复脚本，请求记录保留 */
    setScript(next) {
      script = [...next];
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/**
 * 子进程环境里要加回的 LLM 变量（先用 cleanEnv() 去掉本机的 LLM 变量）：anthropic 时三个，模型用默认值；
 * openai-compatible 必须有模型，再加 CODEINSIGHT_LLM_MODEL。
 */
export function fakeLlmEnv(url, provider = 'anthropic') {
  const env = { CODEINSIGHT_LLM_PROVIDER: provider, CODEINSIGHT_LLM_BASE_URL: url, CODEINSIGHT_LLM_API_KEY: 'test' };
  return provider === 'anthropic' ? env : { ...env, CODEINSIGHT_LLM_MODEL: 'fake-model' };
}

/** 本次请求里所有工具结果的文字（anthropic 的 tool_result 块、openai 的 tool 消息），按出现顺序 */
export function toolResults(req) {
  const out = [];
  for (const m of req.body.messages ?? []) {
    if (m.role === 'tool') out.push(String(m.content));
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
    }
  }
  return out;
}

/** 请求里第一条用户消息的文字（问答的问题）；anthropic 的块数组取其中的文字 */
export function firstUserText(req) {
  const m = (req.body.messages ?? []).find((x) => x.role === 'user');
  if (!m) return '';
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** 请求里最后一条用户消息的文字（两种协议） */
export function lastUserText(req) {
  const msgs = (req.body.messages ?? []).filter((m) => m.role === 'user');
  const content = msgs[msgs.length - 1]?.content;
  return typeof content === 'string' ? content : '';
}

/** 概览请求的输入（第一条用户消息里 `Input:` 下一行的 JSON；重试时最后一条是重试说明）；不是概览请求时返回 undefined */
export function overviewInput(req) {
  const first = (req.body.messages ?? []).find((m) => m.role === 'user')?.content;
  const m = /(?:^|\n)Input:\n(.*)/.exec(typeof first === 'string' ? first : '');
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

/**
 * 概览三类请求的确定性回复：模块名为 `模块-<id>`，功能名为 `功能-<默认组名>`，系统简介标题为 `系统简介`。
 * 回复只由输入决定，同样的输入总是得到同样的回复。
 */
export function overviewReply(req) {
  const input = overviewInput(req);
  if (input?.task === 'module_summary') {
    const interfaces = input.symbols.slice(0, 2).map((s) => ({ key: s.key, summary: `说明 ${s.key}` }));
    const models = input.models.slice(0, 2).map((s) => ({ key: s.key, summary: `模型 ${s.key}` }));
    return JSON.stringify({ name: `模块-${input.module}`, responsibility: `负责 ${input.module}`, interfaces, models });
  }
  if (input?.task === 'feature_naming') {
    return JSON.stringify({ features: input.groups.map((g) => ({ name: `功能-${g.name}`, description: `功能说明 ${g.name}`, entryKeys: g.entries.map((e) => e.key) })) });
  }
  if (input?.task === 'group_summary') return JSON.stringify({ title: `分组-${input.group}`, summary: `分组 ${input.group} 的说明` });
  if (input?.task === 'system_summary') return JSON.stringify({ title: '系统简介', summary: `共 ${(input.modules ?? input.groups).length} 个部分` });
  return '{}';
}
