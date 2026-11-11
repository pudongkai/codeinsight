import { BrowseView } from '../browse/BrowseView';
import { ReviewPage } from '../review/ReviewPage';
import { SourcePanel } from '../source/SourcePanel';
import { NavContext } from './nav';
import { StatusBar } from './StatusBar';
import { useNavigation } from './useNavigation';
import { useStatus } from './useStatus';

/** serve 托管的页面：浏览视图和审查页，右侧为源码面板 */
export function App() {
  const { status, error, refresh, reindex } = useStatus();
  const n = useNavigation(refresh);
  return (
    <NavContext.Provider value={n.nav}>
      <header>
        <StatusBar status={status} error={error} onReindex={() => void reindex()} />
        <nav className="tabs">
          <button type="button" className={n.tab === 'browse' ? 'active' : ''} onClick={() => n.switchTab('browse')} data-testid="tab-browse">浏览</button>
          <button type="button" className={n.tab === 'review' ? 'active' : ''} onClick={() => n.switchTab('review')} data-testid="tab-review">审查</button>
        </nav>
      </header>
      {n.banner && <div className="notice" data-testid="banner">{n.banner}</div>}
      <main className={n.source ? 'with-source' : ''}>
        <div className="content">
          <div hidden={n.tab !== 'browse'}>
            <BrowseView currentSnapshotId={status?.snapshot?.id} trail={n.trail} onHome={n.home} onPickCrumb={n.pickCrumb} />
          </div>
          <div hidden={n.tab !== 'review'}>
            <ReviewPage status={status} refreshStatus={refresh} goneNotice={n.reviewGone} resetGone={n.resetReviewGone} onHostReview={() => n.switchTab('review')} />
          </div>
        </div>
        {n.source && (
          <SourcePanel
            key={`${n.source.snapshotId}:${n.source.symbolId}`}
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
