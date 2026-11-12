import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CHAT_SESSIONS, parseInternalLink, srcLink, Store, symbolLinkIds, symLink } from '../src/index.js';
import type { AskMessageMeta } from '../src/index.js';
import { tempDir } from './helpers/git-repo.js';

function newStore(): Store {
  return new Store(path.join(tempDir('ci-chat-store-'), 'index.db'));
}

const META: AskMessageMeta = { status: 'done', contentKey: 'k', sendSource: true, toolCalls: [{ name: 'search_symbols', args: { query: 'x' }, resultChars: 10, ms: 1 }], refs: {} };

describe('chat sessions and messages', () => {
  it('takes the title from the first question, keeps messages in order and updates updated_at', () => {
    const s = newStore();
    const id = s.chats.createSession('', 1000);
    const q = '退款流程是怎么走的？'.repeat(6);
    s.chats.addMessage(id, 'user', q, null, 2000);
    s.chats.addMessage(id, 'assistant', 'answer', META, 3000);
    s.chats.addMessage(id, 'user', 'second question', null, 4000);
    expect(s.chats.getSession(id)).toMatchObject({ title: [...q].slice(0, 40).join(''), createdAt: 1000, updatedAt: 4000 });
    const msgs = s.chats.messages(id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[1]!.meta).toEqual(META);
    expect(msgs[0]!.meta).toBeNull();
    expect(s.chats.turns(id)).toEqual([{ question: q, answer: 'answer' }]);
    s.close();
  });

  it('deletes messages with the session, and adding to a deleted session throws', () => {
    const s = newStore();
    const id = s.chats.createSession('q');
    s.chats.addMessage(id, 'user', 'q', null);
    expect(s.chats.deleteSession(id)).toBe(true);
    expect(s.chats.deleteSession(id)).toBe(false);
    expect(s.chats.messages(id)).toEqual([]);
    expect(() => s.chats.addMessage(id, 'assistant', 'late', META)).toThrow();
    s.close();
  });

  it('keeps only the 50 most recently updated sessions', () => {
    const s = newStore();
    const first = s.chats.createSession('old but active', 1);
    for (let i = 0; i < MAX_CHAT_SESSIONS; i++) s.chats.createSession(`s${i}`, 10 + i);
    // 新建第 51 个时，updated_at 最早的那个被清理
    expect(s.chats.getSession(first)).toBeUndefined();
    const second = s.chats.listSessions().at(-1)!;
    s.chats.addMessage(second.id, 'user', 'touch', null, 10_000);
    s.chats.createSession('newest', 10_001);
    expect(s.chats.getSession(second.id)).toBeDefined();
    expect(s.chats.listSessions()).toHaveLength(MAX_CHAT_SESSIONS);
    expect(s.chats.listSessions()[0]!.title).toBe('newest');
    s.close();
  });
});

describe('internal links', () => {
  it('parses sym: and src: links and rejects everything else', () => {
    expect(parseInternalLink('sym:abc123')).toEqual({ kind: 'sym', id: 'abc123' });
    expect(parseInternalLink('src:app/x.py#L10-L20')).toEqual({ kind: 'src', path: 'app/x.py', start: 10, end: 20 });
    expect(parseInternalLink('src:app/x.py#L7')).toEqual({ kind: 'src', path: 'app/x.py', start: 7, end: 7 });
    expect(parseInternalLink('src:app/x.py')).toEqual({ kind: 'src', path: 'app/x.py' });
    expect(parseInternalLink('src:app/x.py#L20-L10')).toEqual({ kind: 'src', path: 'app/x.py' });
    for (const bad of ['javascript:alert(1)', 'https://x.test', 'src:../etc/passwd', 'src:/etc/passwd', 'sym:', 'sym:a b', 'src:a/%2e%2e/b', 'src:./a.py', 'src:a//b.py', 'src:C:/x.py']) {
      expect(parseInternalLink(bad)).toBeUndefined();
    }
    expect(parseInternalLink(srcLink('a/b.py', 3, 9))).toEqual({ kind: 'src', path: 'a/b.py', start: 3, end: 9 });
    expect(parseInternalLink(symLink('f00'))).toEqual({ kind: 'sym', id: 'f00' });
  });

  it('collects symbol ids linked in an answer', () => {
    expect(symbolLinkIds('See [a](sym:aa) and [b](sym:bb), [a again](sym:aa), [src](src:x.py#L1-L2), [x](http://e)')).toEqual(['aa', 'bb']);
  });
});
