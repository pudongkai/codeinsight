import { useState } from 'react';
import type { StatusResponse } from '../api/types';
import { Modal } from '../settings/Modal';
import { OpenRepoErrorView, OpenRepoForm } from './OpenRepoForm';
import { RecentRepos } from './RecentRepos';
import { useOpenRepo } from './useOpenRepo';

/** 打开其他仓库的弹窗：和选择仓库页相同的输入框 */
function OpenOtherDialog({ opener, status, onClose }: { opener: ReturnType<typeof useOpenRepo>; status: StatusResponse; onClose(): void }) {
  return (
    <Modal label="打开其他仓库" testId="repo-dialog">
      <h3>打开其他仓库</h3>
      <OpenRepoForm opener={opener} dirPickerAvailable={status.dirPickerAvailable} />
      <div className="actions">
        <button type="button" className="small" data-testid="repo-dialog-close" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

/** 顶栏仓库名旁的下拉：最近使用的仓库和“打开其他仓库…”；切换成功后调用 onSwitched */
export function RepoSwitcher({ status, onSwitched }: { status: StatusResponse; onSwitched(): void }) {
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(false);
  const opener = useOpenRepo(() => {
    setMenu(false);
    setDialog(false);
    onSwitched();
  });
  return (
    <span className="repo-switcher">
      <button type="button" className="repo-button" data-testid="repo-menu-button" onClick={() => setMenu((v) => !v)}>
        <code className="repo" data-testid="repo-name">{status.repo}</code> ▾
      </button>
      {menu && (
        <div className="panel repo-menu" data-testid="repo-menu">
          <RecentRepos disabled={opener.busy} onOpen={(p) => void opener.open(p)} />
          <OpenRepoErrorView opener={opener} />
          <button type="button" className="link" data-testid="repo-open-other" onClick={() => { setMenu(false); setDialog(true); }}>打开其他仓库…</button>
        </div>
      )}
      {dialog && <OpenOtherDialog opener={opener} status={status} onClose={() => setDialog(false)} />}
    </span>
  );
}
