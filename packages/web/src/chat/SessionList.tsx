import type { ChatSessionInfo } from '@codeinsight/core/ask/events';
import { useState } from 'react';
import { formatTime } from '../format';

interface Props {
  sessions: ChatSessionInfo[];
  currentId: number | undefined;
  isNew: boolean;
  onPick(id: number | 'new'): void;
  onDelete(id: number): void;
}

/** 删除要点两次：第一次变成“确认删除” */
function DeleteButton({ onDelete }: { onDelete(): void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <button type="button" className="small" data-testid="session-delete" onBlur={() => setConfirming(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (confirming) onDelete();
        else setConfirming(true);
      }}>
      {confirming ? '确认删除' : '删除'}
    </button>
  );
}

/** 左侧会话列表：新建、切换、删除 */
export function SessionList({ sessions, currentId, isNew, onPick, onDelete }: Props) {
  return (
    <aside className="panel chat-sessions" data-testid="session-list">
      <button type="button" className="primary" data-testid="session-new" onClick={() => onPick('new')}>新建会话</button>
      {isNew && <div className="session-item active">新会话</div>}
      {sessions.map((s) => (
        <div key={s.id} className={`session-item${s.id === currentId ? ' active' : ''}`} data-testid="session-item" data-id={s.id}
          onClick={() => onPick(s.id)}>
          <div className="session-title">{s.title || '新会话'}</div>
          <div className="session-meta muted">
            <span>{formatTime(s.updatedAt)}</span>
            <DeleteButton onDelete={() => onDelete(s.id)} />
          </div>
        </div>
      ))}
      {sessions.length === 0 && !isNew && <p className="muted">还没有会话</p>}
    </aside>
  );
}
