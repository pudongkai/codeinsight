import { useState } from 'react';
import { openInHost } from '../bridge';
import type { Crumb } from '../browse/Breadcrumbs';
import type { SourceTarget } from '../source/useSource';
import type { Nav, SymbolLocator } from './nav';

export type Tab = 'browse' | 'review';

/** 页面导航状态：当前标签、邻居图的浏览路径、源码面板，以及快照失效时的回退 */
export function useNavigation(refreshStatus: () => void) {
  const [tab, setTab] = useState<Tab>('browse');
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [origin, setOrigin] = useState<'browse' | 'review'>('browse');
  const [source, setSource] = useState<SourceTarget>();
  const [banner, setBanner] = useState<string>();
  const [reviewGone, setReviewGone] = useState(false);

  const showSource = (s: SymbolLocator) => setSource({ snapshotId: s.snapshotId, symbolId: s.id });
  const nav: Nav = {
    showSource,
    openSymbol: (s) => {
      if (!openInHost({ path: s.path, line: s.line, removed: s.removed })) showSource(s);
    },
    openGraph: (s, from) => {
      if (from) setOrigin(from);
      setBanner(undefined);
      setTrail((t) => {
        const kept = t.filter((c) => c.snapshotId === s.snapshotId);
        return kept.at(-1)?.id === s.id ? kept : [...kept, { snapshotId: s.snapshotId, id: s.id, name: s.name }];
      });
      setTab('browse');
    },
    snapshotGone: () => {
      refreshStatus();
      setTrail([]);
      setSource(undefined);
      // 审查页里打开的源码，或从审查报告进入的邻居图：回到审查页并在报告上提示
      if (tab === 'review' || origin === 'review') {
        setReviewGone(true);
        setTab('review');
      } else setBanner('索引已更新，原来的快照已清理，已回到入口列表。');
    },
    indexNotReady: () => refreshStatus(),
  };
  const home = () => setTrail([]);
  const pickCrumb = (i: number) => setTrail((t) => t.slice(0, i + 1));
  return {
    nav, tab, trail,
    /** 手动切换标签时关掉源码面板 */
    switchTab: (t: Tab) => {
      setTab(t);
      setSource(undefined);
    }, home, pickCrumb, source, closeSource: () => setSource(undefined), banner, reviewGone, resetReviewGone: () => setReviewGone(false),
  };
}
