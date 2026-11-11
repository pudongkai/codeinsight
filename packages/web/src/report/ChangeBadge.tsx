import type { SymbolChange } from '@codeinsight/core/report/types';
import { CHANGE_LABELS, entryLabel } from '../format';

export function ChangeBadge({ change }: { change: SymbolChange['change'] }) {
  return <span className={`badge change-${change}`}>{CHANGE_LABELS[change]}</span>;
}

/** 入口标签：入口函数显示框架和路由；调用方为 0 的入口不算"无调用方" */
export function EntryTag({ entry }: { entry: SymbolChange['entry'] }) {
  if (!entry) return null;
  return (
    <span className="badge entry" title={entryLabel(entry)}>
      入口 · {entryLabel(entry)}
    </span>
  );
}

export function CallerCounts({ c }: { c: SymbolChange }) {
  if (c.callers.prod + c.callers.test === 0) return <span className="muted">{c.entry ? '' : '无调用方'}</span>;
  return (
    <span className="counts" title="正式代码 / 测试代码调用方">
      调用方 正式 {c.callers.prod} / 测试 {c.callers.test}
    </span>
  );
}
