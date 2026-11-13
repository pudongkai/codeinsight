import type { OverviewReport } from '@codeinsight/core/overview/types';
import type { OverviewResponse } from '../api/types';
import { basedOn, formatTime } from '../format';

interface Props {
  data: OverviewResponse;
  /** 正在查看指定的记录（不是当前概览） */
  viewingOther: boolean;
  busy: boolean;
  onGenerate(): void;
  onView(id: number | undefined): void;
}

function Stats({ r }: { r: OverviewReport }) {
  const s = r.stats;
  return (
    <div className="stats" data-testid="overview-stats">
      <span><b>{s.files}</b> 个文件</span><span><b>{s.modules}</b> 个模块</span><span><b>{s.httpApis}</b> 个接口</span>
      <span><b>{s.models}</b> 个模型</span><span><b>{s.functions}</b> 个函数</span>
    </div>
  );
}

function aiText(r: OverviewReport): string {
  if (!r.llm) return '未使用 AI';
  const src = r.llm.sendSource ? '含源码片段' : '不含源码片段';
  return `${r.llm.provider}（${r.llm.model}），${src}；本次请求 ${r.ai.calls} 次，命中缓存 ${r.ai.cached} 次${r.ai.failed > 0 ? `，失败 ${r.ai.failed} 次` : ''}`;
}

/** 过期、有更新的结构概览、正在看历史记录时的提示 */
function Notices({ data, viewingOther, busy, onGenerate, onView }: Props) {
  return (
    <>
      {data.stale && (
        <div className="notice" data-testid="overview-stale">
          概览基于 {formatTime(data.overview.snapshot.createdAt)} 建索引时的代码，代码已有变化，位置可能有变化。{' '}
          <button type="button" className="small" disabled={busy} onClick={onGenerate}>更新概览</button>
        </div>
      )}
      {data.newerStructureId !== undefined && (
        <div className="notice" data-testid="overview-newer">
          有更新的结构概览（不含 AI 说明）。{' '}
          <button type="button" className="small" data-testid="view-newer" onClick={() => onView(data.newerStructureId)}>查看</button>
        </div>
      )}
      {viewingOther && (
        <div className="notice" data-testid="overview-viewing">
          正在查看概览 #{data.id}。 <button type="button" className="small" data-testid="view-current" onClick={() => onView(undefined)}>回到当前概览</button>
        </div>
      )}
    </>
  );
}

/** 系统简介卡片：标题、简介、统计、生成时间和模型，以及“更新概览” */
export function SystemCard(props: Props) {
  const r = props.data.overview;
  return (
    <>
      <section className="panel" data-testid="system-card">
        <div className="panel-head">
          <h2 data-testid="system-title">{r.system?.title ?? '系统概览'}</h2>
          <button type="button" className="small" data-testid="overview-generate" disabled={props.busy} onClick={props.onGenerate}>更新概览</button>
        </div>
        {r.system ? <p data-testid="system-summary">{r.system.summary}</p> : <p className="muted">没有 AI 生成的系统简介（未配置 LLM、只生成了结构部分或请求失败）。</p>}
        <Stats r={r} />
        <p className="muted" data-testid="overview-source">
          生成于 {formatTime(r.generatedAt)} · {basedOn(r.snapshot.commitSha, props.data.snapshotDirty)} · {aiText(r)}
        </p>
      </section>
      <Notices {...props} />
    </>
  );
}
