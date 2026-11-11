import type { ReviewReport } from '@codeinsight/core/report/types';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';

/** 报告对应的快照是否已被清理：用报告里第一个函数查一次详情，410 即已清理 */
export function useSnapshotProbe(report: ReviewReport | undefined): boolean {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    const c = report?.modules[0]?.symbols[0];
    if (!report || !c) return;
    const snap = c.change === 'removed' ? report.base.snapshotId : report.head.snapshotId;
    if (snap === null) return;
    let cancelled = false;
    api.symbol(snap, c.id).catch((err: unknown) => {
      if (!cancelled && err instanceof ApiError && err.snapshotGone) setGone(true);
    });
    return () => {
      cancelled = true;
    };
  }, [report]);
  return gone;
}
