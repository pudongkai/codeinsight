import { useState } from 'react';
import { taskLabel } from './labels';
import type { RepoOpener } from './useOpenRepo';
import { usePickDir } from './usePickDir';

/** 打开失败的说明；repo_busy 时列出任务，全部可以取消时提供“取消并切换” */
export function OpenRepoErrorView({ opener }: { opener: RepoOpener }) {
  const e = opener.error;
  if (!e) return null;
  const tasks = e.tasks ?? [];
  const cancellable = tasks.length > 0 && tasks.every((t) => t.cancellable);
  return (
    <div className="error" data-testid="repo-open-error">
      {e.text}
      {tasks.length > 0 && (
        <ul data-testid="repo-busy-tasks">
          {tasks.map((t) => <li key={`${t.kind}-${t.id}`}>{taskLabel(t)}</li>)}
        </ul>
      )}
      {cancellable && (
        <button type="button" className="small" data-testid="repo-cancel-switch" disabled={opener.busy} onClick={() => void opener.open(e.path, true)}>取消并切换</button>
      )}
      {tasks.length > 0 && !cancellable && <div data-testid="repo-wait-tasks">等任务结束后再切换</div>}
    </div>
  );
}

interface Props {
  opener: RepoOpener;
  dirPickerAvailable: boolean;
}

/** 仓库路径输入框、“选择目录…”（能弹出系统窗口时）和“打开” */
export function OpenRepoForm({ opener, dirPickerAvailable }: Props) {
  const [path, setPath] = useState('');
  const picker = usePickDir(setPath);
  return (
    <form className="repo-form" onSubmit={(e) => { e.preventDefault(); void opener.open(path); }}>
      <div className="row">
        <input data-testid="repo-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="仓库的绝对路径，如 /Users/me/project 或 ~/project" />
        {dirPickerAvailable && (
          <button type="button" className="small" data-testid="repo-pick-dir" disabled={picker.waiting} onClick={() => void picker.pick()}>
            {picker.waiting ? '等待选择…' : '选择目录…'}
          </button>
        )}
        <button type="submit" data-testid="repo-open" disabled={opener.busy || path.trim() === ''}>{opener.busy ? '正在打开…' : '打开'}</button>
      </div>
      <p className="muted">会在仓库里创建 .codeinsight 数据目录（已自动加 .gitignore）</p>
      {picker.error && <div className="error" data-testid="repo-pick-error">{picker.error}</div>}
      <OpenRepoErrorView opener={opener} />
    </form>
  );
}
