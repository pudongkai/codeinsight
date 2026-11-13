import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatusResponse } from '../api/types';
import { BrowseView } from '../browse/BrowseView';
import { ChatPage } from '../chat/ChatPage';
import { OverviewPage } from '../overview/OverviewPage';
import { RepoPage } from '../repo/RepoPage';
import { ReviewPage } from '../review/ReviewPage';
import { SettingsContext } from '../settings/context';
import { SettingsDialog } from '../settings/SettingsDialog';
import { SourcePanel } from '../source/SourcePanel';
import { sourceKey } from '../source/useSource';
import { NavContext } from './nav';
import { StatusBar } from './StatusBar';
import { useNavigation, type Tab } from './useNavigation';
import { useStatus } from './useStatus';

const TABS: [Tab, string][] = [['overview', '概览'], ['browse', '浏览'], ['chat', '问答'], ['review', '审查']];

type StatusState = ReturnType<typeof useStatus>;

/** 仓库换了（本页或别的页面切换）时的提示“已切换到仓库 xxx”；第一次打开仓库不提示 */
function useSwitchNotice(status: StatusResponse | undefined) {
  const prev = useRef<number | null | undefined>(undefined);
  const [notice, setNotice] = useState<string>();
  const gen = status?.repoGen;
  useEffect(() => {
    if (gen === undefined) return;
    if (typeof prev.current === 'number' && gen !== prev.current && status?.repo) setNotice(`已切换到仓库 ${status.repo}`);
    prev.current = gen;
  }, [gen]);
  return { notice, dismiss: () => setNotice(undefined) };
}

function Notice({ text, onDismiss }: { text: string; onDismiss(): void }) {
  return (
    <div className="notice" data-testid="repo-switched">
      {text} <button type="button" className="small" onClick={onDismiss}>知道了</button>
    </div>
  );
}

/** 一个仓库的页面：标签页、各页内容和源码面板；仓库换了时由上层按 repoGen 整个重建，导航状态回到初始 */
function RepoView({ s, switched }: { s: StatusState; switched: ReturnType<typeof useSwitchNotice> }) {
  const { status, refresh } = s;
  const n = useNavigation(refresh, status && (status.overview ? 'overview' : 'browse'));
  return (
    <NavContext.Provider value={n.nav}>
      <header>
        <StatusBar status={status} error={s.error} onReindex={() => void s.reindex()} onRepoSwitched={refresh} />
        <nav className="tabs">
          {TABS.map(([t, label]) => (
            <button key={t} type="button" className={n.tab === t ? 'active' : ''} onClick={() => n.switchTab(t)} data-testid={`tab-${t}`}>{label}</button>
          ))}
        </nav>
      </header>
      {switched.notice && <Notice text={switched.notice} onDismiss={switched.dismiss} />}
      {n.banner && <div className="notice" data-testid="banner">{n.banner}</div>}
      <main className={n.source ? 'with-source' : ''}>
        <div className="content">
          <div hidden={n.tab !== 'overview'}>
            <OverviewPage status={status} refreshStatus={refresh} />
          </div>
          <div hidden={n.tab !== 'browse'}>
            <BrowseView currentSnapshotId={status?.snapshot?.id} trail={n.trail} onHome={n.home} onPickCrumb={n.pickCrumb} />
          </div>
          <div hidden={n.tab !== 'chat'}>
            <ChatPage status={status} />
          </div>
          <div hidden={n.tab !== 'review'}>
            <ReviewPage status={status} refreshStatus={refresh} goneNotice={n.reviewGone} resetGone={n.resetReviewGone} onHostReview={() => n.switchTab('review')} />
          </div>
        </div>
        {n.source && (
          <SourcePanel
            key={sourceKey(n.source)}
            target={n.source}
            onClose={n.closeSource}
            onGone={n.nav.snapshotGone}
            onNavigate={(snapshotId, src) => n.nav.openGraph({ snapshotId, id: src.id, name: src.qualifiedName })}
          />
        )}
      </main>
    </NavContext.Provider>
  );
}

/** 还没读到状态，或没有打开仓库：顶栏只有设置入口，没有仓库时内容区是选择仓库页 */
function NoRepoView({ s }: { s: StatusState }) {
  return (
    <>
      <header>
        <StatusBar status={s.status} error={s.error} onReindex={() => void s.reindex()} onRepoSwitched={s.refresh} />
      </header>
      {s.status && (
        <main className="standalone">
          <RepoPage dirPickerAvailable={s.status.dirPickerAvailable} onOpened={s.refresh} />
        </main>
      )}
    </>
  );
}

/** serve 托管的页面：没有仓库时显示选择仓库页；有仓库时显示概览、浏览、问答和审查，右侧为源码面板 */
export function App() {
  const s = useStatus();
  const switched = useSwitchNotice(s.status);
  const [settings, setSettings] = useState(false);
  const openSettings = useCallback(() => setSettings(true), []);
  const repoGen = s.status?.repoGen;
  return (
    <SettingsContext.Provider value={openSettings}>
      {s.status?.repo ? <RepoView key={repoGen ?? 'none'} s={s} switched={switched} /> : <NoRepoView s={s} />}
      {settings && <SettingsDialog onClose={() => setSettings(false)} onSaved={s.refresh} />}
    </SettingsContext.Provider>
  );
}
