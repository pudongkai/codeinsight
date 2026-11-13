import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { RecentRepo } from '../api/types';
import { useApi } from '../browse/useApi';
import { formatTime } from '../format';

interface ItemProps {
  r: RecentRepo;
  current: boolean;
  disabled: boolean;
  onOpen(path: string): void;
  onRemove(path: string): void;
}

/** 一项最近使用的仓库：点击打开；路径不存在时灰显并可移除 */
function RecentItem({ r, current, disabled, onOpen, onRemove }: ItemProps) {
  return (
    <li className={`recent-repo${r.exists ? '' : ' missing'}`} data-testid="recent-repo" data-path={r.path}>
      <button type="button" className="link" disabled={disabled || !r.exists || current} onClick={() => onOpen(r.path)}>
        <code>{r.path}</code>
      </button>
      {current && <span className="tag" data-testid="recent-current">当前</span>}
      <span className="muted">{r.exists ? `上次打开 ${formatTime(r.lastOpenedAt)}` : '路径不存在'}</span>
      {!r.exists && <button type="button" className="small" data-testid="recent-remove" onClick={() => onRemove(r.path)}>移除</button>}
    </li>
  );
}

/** 最近使用的仓库列表（GET /api/repos）；当前仓库标“当前” */
export function RecentRepos({ disabled, onOpen }: { disabled: boolean; onOpen(path: string): void }) {
  const [round, setRound] = useState(0);
  const [removeError, setRemoveError] = useState<string>();
  const repos = useApi(() => api.repos(), [round]);
  const remove = async (path: string) => {
    setRemoveError(undefined);
    try {
      await api.removeRecentRepo(path);
      setRound((n) => n + 1);
    } catch (err) {
      setRemoveError(`移除失败：${errorMessage(err)}`);
    }
  };
  const list = repos.data?.recent ?? [];
  return (
    <div className="recent-repos" data-testid="recent-repos">
      {repos.error && <div className="error">读取最近使用的仓库失败：{repos.error}</div>}
      {removeError && <div className="error">{removeError}</div>}
      {repos.data && list.length === 0 && <p className="muted">还没有打开过仓库。</p>}
      <ul>
        {list.map((r) => (
          <RecentItem key={r.path} r={r} current={r.path === repos.data?.current?.path} disabled={disabled} onOpen={onOpen} onRemove={(p) => void remove(p)} />
        ))}
      </ul>
    </div>
  );
}
