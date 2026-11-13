import type { ProposalView } from '@codeinsight/core/ask/events';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ProposalConflict, ProposalFileDiff } from '../api/types';
import { apiErrorText } from './proposal-text';

export type ProposalAction = 'apply' | 'dismiss';

/** 409 等错误里带回的最新卡片和冲突文件 */
function errorExtra(err: unknown): { proposal?: ProposalView; files?: ProposalConflict[] } {
  return err instanceof ApiError ? (err.extra as { proposal?: ProposalView; files?: ProposalConflict[] }) : {};
}

/**
 * 一张确认卡片的状态和操作：执行或忽略后用接口返回的卡片显示，直到会话重新读到更新的记录。
 * 冲突时记下冲突文件（可带 force 重发）；not_applicable 的记录不能再执行。
 * runs 在每次执行或忽略结束后加一，diff 据此重新读取，显示的是和磁盘当前内容的对比。
 */
export function useProposal(initial: ProposalView) {
  const [local, setLocal] = useState<ProposalView>();
  const [busy, setBusy] = useState<ProposalAction>();
  const [error, setError] = useState<string>();
  const [conflicts, setConflicts] = useState<ProposalConflict[]>([]);
  const [unusable, setUnusable] = useState(false);
  const [runs, setRuns] = useState(0);
  const view = local && local.updatedAt >= initial.updatedAt ? local : initial;

  const fail = (err: unknown) => {
    const { proposal, files } = errorExtra(err);
    if (proposal) setLocal(proposal);
    if (err instanceof ApiError && err.code === 'not_applicable') setUnusable(true);
    if (files && files.length > 0) return setConflicts(files);
    // 执行中途失败时卡片的结果里已经有原因，不再重复显示
    if (!(err instanceof ApiError && proposal?.result?.error?.code === err.code)) setError(apiErrorText(err));
  };

  const run = async (action: ProposalAction, call: () => Promise<{ proposal: ProposalView }>) => {
    setBusy(action);
    setError(undefined);
    setConflicts([]);
    try {
      setLocal((await call()).proposal);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(undefined);
      setRuns((n) => n + 1);
    }
  };

  return {
    view, busy, error, conflicts, unusable, runs,
    apply: (force = false) => run('apply', () => api.applyProposal(view.id, force)),
    dismiss: () => run('dismiss', () => api.dismissProposal(view.id)),
  };
}

interface LoadedDiff {
  /** 读取时的 runs */
  runs: number;
  files?: ProposalFileDiff[];
  error?: string;
}

/**
 * 按需加载一张卡片的 diff：展开时读取；同一个 runs 内读到的结果复用，
 * runs 变化后（执行失败、冲突）展开着的立即重新读取，收起的下次展开时再读。
 * 读取中 runs 又变了时，读完后发现结果已过期会再读一次；重新读取期间展开着的仍显示上一次的结果，不显示空白
 */
export function useProposalDiff(id: number, runs: number) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<LoadedDiff>();
  const [loading, setLoading] = useState(false);
  const current = loaded?.runs === runs || loading ? loaded : undefined;
  const load = async () => {
    setLoading(true);
    try {
      setLoaded({ runs, files: (await api.proposalDiff(id)).files });
    } catch (err) {
      setLoaded({ runs, error: apiErrorText(err) });
    } finally {
      setLoading(false);
    }
  };
  const stale = loaded?.runs !== runs || (loaded.files === undefined && loaded.error === undefined);
  useEffect(() => {
    if (open && stale && !loading) void load();
  }, [open, runs, loading, stale]);
  const toggle = () => setOpen(!open);
  return { open, files: current?.files, error: current?.error, loading, toggle };
}
