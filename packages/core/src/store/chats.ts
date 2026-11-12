import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AskMessageMeta, ChatMessageInfo, ChatSessionInfo } from '../ask/events.js';
import { log } from '../log.js';

type Row = Record<string, SQLInputValue>;

/** 只保留最近这么多个会话（按 updated_at） */
export const MAX_CHAT_SESSIONS = 50;
/** 会话标题取第一个问题的前这么多个字符 */
export const CHAT_TITLE_CHARS = 40;

/** 会话里的一轮：问题和最终回答（不含工具结果） */
export interface ChatTurn {
  question: string;
  answer: string;
}

/** 标题：去掉首尾空白后的前 40 个字符（按码点计，不切开代理对） */
export function chatTitle(text: string): string {
  return [...text.trim()].slice(0, CHAT_TITLE_CHARS).join('');
}

function toSession(r: Row): ChatSessionInfo {
  return { id: Number(r.id), title: String(r.title), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

function toMessage(r: Row): ChatMessageInfo {
  return {
    id: Number(r.id), sessionId: Number(r.session_id), role: r.role as ChatMessageInfo['role'], content: String(r.content),
    meta: r.meta == null ? null : (JSON.parse(String(r.meta)) as AskMessageMeta), createdAt: Number(r.created_at),
  };
}

/** chat_sessions、chat_messages 表的读写 */
export class ChatTable {
  constructor(private readonly db: DatabaseSync) {}

  /** 新建会话并清理超出数量的旧会话；不给标题时在第一个问题保存时补上 */
  createSession(title = '', now = Date.now()): number {
    const r = this.db.prepare('INSERT INTO chat_sessions(title, created_at, updated_at) VALUES (?, ?, ?)').run(chatTitle(title), now, now);
    const id = Number(r.lastInsertRowid);
    log.info('chat_session_created', { id });
    this.prune();
    return id;
  }

  /** 最近更新的在前 */
  listSessions(): ChatSessionInfo[] {
    return (this.db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC, id DESC').all() as Row[]).map(toSession);
  }

  getSession(id: number): ChatSessionInfo | undefined {
    const r = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? toSession(r) : undefined;
  }

  /** 会话的全部消息，按先后顺序 */
  messages(sessionId: number): ChatMessageInfo[] {
    return (this.db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id').all(sessionId) as Row[]).map(toMessage);
  }

  /** 删除会话，消息随外键一起删除；返回是否删除了 */
  deleteSession(id: number): boolean {
    const n = Number(this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id).changes);
    if (n > 0) log.info('chat_session_deleted', { id });
    return n > 0;
  }

  /**
   * 追加一条消息并更新会话的 updated_at；会话不存在（已被删除）时外键检查失败并抛错，由调用方决定如何处理。
   * 第一个问题时会话标题为空的，用问题补上标题。
   */
  addMessage(sessionId: number, role: ChatMessageInfo['role'], content: string, meta: AskMessageMeta | null, now = Date.now()): number {
    const r = this.db
      .prepare('INSERT INTO chat_messages(session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, role, content, meta ? JSON.stringify(meta) : null, now);
    this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    if (role === 'user') {
      this.db.prepare("UPDATE chat_sessions SET title = ? WHERE id = ? AND title = ''").run(chatTitle(content), sessionId);
    }
    return Number(r.lastInsertRowid);
  }

  /** 会话里的问答轮次：每个问题配它之后的第一条回答；没有回答或回答为空的问题跳过 */
  turns(sessionId: number): ChatTurn[] {
    const out: ChatTurn[] = [];
    let question: string | undefined;
    for (const m of this.messages(sessionId)) {
      if (m.role === 'user') question = m.content;
      else if (question !== undefined) {
        if (m.content) out.push({ question, answer: m.content });
        question = undefined;
      }
    }
    return out;
  }

  /** 只保留最近 keep 个会话 */
  prune(keep = MAX_CHAT_SESSIONS): void {
    const n = Number(this.db
      .prepare('DELETE FROM chat_sessions WHERE id NOT IN (SELECT id FROM chat_sessions ORDER BY updated_at DESC, id DESC LIMIT ?)')
      .run(keep).changes);
    if (n > 0) log.info('chat_sessions_pruned', { deleted: n });
  }
}
