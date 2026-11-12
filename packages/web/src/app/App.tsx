import { BrowseView } from '../browse/BrowseView';
import { ChatPage } from '../chat/ChatPage';
import { OverviewPage } from '../overview/OverviewPage';
import { ReviewPage } from '../review/ReviewPage';
import { SourcePanel } from '../source/SourcePanel';
import { sourceKey } from '../source/useSource';
import { NavContext } from './nav';
import { StatusBar } from './StatusBar';
import { useNavigation, type Tab } from './useNavigation';
import { useStatus } from './useStatus';

const TABS: [Tab, string][] = [['overview', '概览'], ['browse', '浏览'], ['chat', '问答'], ['review', '审查']];

/** serve 托管的页面：概览、浏览视图、问答和审查页，右侧为源码面板；已有概览时默认打开概览 */
export function App() {
  const { status, error, refresh, reindex } = useStatus();
  const n = useNavigation(refresh, status && (status.overview ? 'overview' : 'browse'));
  return (
    <NavContext.Provider value={n.nav}>
      <header>
        <StatusBar status={status} error={error} onReindex={() => void reindex()} />
        <nav className="tabs">
          {TABS.map(([t, label]) => (
            <button key={t} type="button" className={n.tab === t ? 'active' : ''} onClick={() => n.switchTab(t)} data-testid={`tab-${t}`}>{label}</button>
          ))}
        </nav>
      </header>
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
            onNavigate={(snapshotId, s) => n.nav.openGraph({ snapshotId, id: s.id, name: s.qualifiedName })}
          />
        )}
      </main>
    </NavContext.Provider>
  );
}
