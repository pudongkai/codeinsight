import type { ReviewReport } from '@codeinsight/core/report/types';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import { sideOf } from '../report/report-graph';

/**
 * base 和 head 各挑一个函数用来查详情：优先挑本来就在那一边的改动函数。
 * 只看 410，函数在该快照里不存在（404）不影响判断。
 */
function probes(report: ReviewReport): { snapshotId: number; id: string }[] {
  const changes = report.modules.flatMap((m) => m.symbols);
  const first = changes[0];
  if (!first) return [];
  return (['base', 'head'] as const).flatMap((side) => {
    const snapshotId = report[side].snapshotId;
    if (snapshotId === null) return [];
    const c = changes.find((x) => sideOf(x) === side) ?? first;
    return [{ snapshotId, id: c.id }];
  });
}

/** 报告对应的快照（base 或 head 任一边）是否已被清理：两边各查一次函数详情，410 即已清理 */
export function useSnapshotProbe(report: ReviewReport | undefined): boolean {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    if (!report) return;
    let cancelled = false;
    for (const p of probes(report)) {
      api.symbol(p.snapshotId, p.id).catch((err: unknown) => {
        if (!cancelled && err instanceof ApiError && err.snapshotGone) setGone(true);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [report]);
  return gone;
}
