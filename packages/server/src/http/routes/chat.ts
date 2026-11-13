import { askClient, isQuestionTooLong, log, MAX_QUESTION_CHARS, runAsk } from '@codeinsight/core';
import type { AskEvent, ChatSessionInfo, LlmClient, SnapshotRow } from '@codeinsight/core';
import { repoOf, type Route, type RequestContext } from '../context.js';
import { HttpError, idParam, optString, readJsonBody, sendJson } from '../respond.js';
import { currentSnapshot } from '../snapshot.js';

/** 问题正文不进日志，只记长度 */
function parseQuestion(body: Record<string, unknown>): string {
  const q = body.question;
  if (typeof q !== 'string' || q.trim() === '') throw new HttpError(400, 'invalid_param', 'question must be a non-empty string');
  if (isQuestionTooLong(q)) throw new HttpError(400, 'invalid_param', `question must be at most ${MAX_QUESTION_CHARS} characters`);
  return q;
}

function requireSession(ctx: RequestContext): ChatSessionInfo {
  const id = idParam(ctx.params.id, 'session id');
  ctx.logFields.sessionId = id;
  const s = repoOf(ctx).ws.store.chats.getSession(id);
  if (!s) throw new HttpError(404, 'session_not_found');
  return s;
}

function listSessions(ctx: RequestContext): void {
  sendJson(ctx.res, 200, { sessions: repoOf(ctx).ws.store.chats.listSessions() });
}

/** POST /api/chat/sessions `{title?}`：不给标题时用第一个问题补上 */
async function createSession(ctx: RequestContext): Promise<void> {
  const title = optString(await readJsonBody(ctx.req), 'title') ?? '';
  const id = repoOf(ctx).ws.store.chats.createSession(title);
  ctx.logFields.sessionId = id;
  sendJson(ctx.res, 201, { id });
}

/** 会话、是否正在回答和全部消息 */
function getSession(ctx: RequestContext): void {
  const s = requireSession(ctx);
  sendJson(ctx.res, 200, { ...s, answering: repoOf(ctx).askRuns.isAnswering(s.id), messages: repoOf(ctx).ws.store.chats.messages(s.id) });
}

/** 有正在回答的问题时先中止它、等回答保存，再删除会话（消息随外键一起删除） */
async function deleteSession(ctx: RequestContext): Promise<void> {
  const s = requireSession(ctx);
  const cancelled = await repoOf(ctx).askRuns.cancel(s.id, 'session_deleted');
  repoOf(ctx).ws.store.chats.deleteSession(s.id);
  ctx.logFields.cancelled = cancelled;
  sendJson(ctx.res, 200, { deleted: true, cancelled });
}

interface AnswerInput {
  sessionId: number;
  question: string;
  snapshot: SnapshotRow;
  client: LlmClient;
}

/** 以 NDJSON 逐行写出事件；客户端断开时中止回答（runAsk 把消息记为 cancelled 并保存已收到的文字） */
async function streamAnswer(ctx: RequestContext, input: AnswerInput, signal: AbortSignal): Promise<void> {
  const { res } = ctx;
  const { repo, store, layout, config } = repoOf(ctx).ws;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  res.flushHeaders();
  const onClose = () => {
    if (res.writableFinished) return;
    log.info('ask_client_disconnected', { sessionId: input.sessionId });
    void repoOf(ctx).askRuns.cancel(input.sessionId, 'client_disconnected');
  };
  res.on('close', onClose);
  const write = (e: AskEvent) => {
    if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(e) + '\n');
  };
  try {
    await runAsk({ repo, store, layout, config, ...input, signal, onEvent: write });
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

/**
 * POST /api/chat/sessions/:id/messages `{question}`：开始前的错误用普通 JSON 返回
 * （LLM 未配置 400、快照未就绪 503、同一会话已在回答 409、整个服务已有 2 个问题在回答 429），开始后以 NDJSON 流式返回事件。
 */
async function askQuestion(ctx: RequestContext): Promise<void> {
  const question = parseQuestion(await readJsonBody(ctx.req));
  ctx.logFields.questionChars = question.length;
  const session = requireSession(ctx);
  const c = askClient(repoOf(ctx).ws.config);
  if ('code' in c) throw new HttpError(400, c.code, c.message);
  const input: AnswerInput = { sessionId: session.id, question, snapshot: currentSnapshot(ctx), client: c.client };
  const r = repoOf(ctx).askRuns.start(session.id, (signal) => streamAnswer(ctx, input, signal));
  if (!r.ok) {
    throw r.code === 'session_busy'
      ? new HttpError(409, 'session_busy', 'this session is already answering a question')
      : new HttpError(429, 'too_many_questions', 'too many questions are being answered; try again later');
  }
  await r.done;
}

export const chatRoutes: Route[] = [
  { method: 'GET', pattern: '/api/chat/sessions', handler: listSessions },
  { method: 'POST', pattern: '/api/chat/sessions', handler: createSession },
  { method: 'GET', pattern: '/api/chat/sessions/:id', handler: getSession },
  { method: 'DELETE', pattern: '/api/chat/sessions/:id', handler: deleteSession },
  { method: 'POST', pattern: '/api/chat/sessions/:id/messages', handler: askQuestion },
];
