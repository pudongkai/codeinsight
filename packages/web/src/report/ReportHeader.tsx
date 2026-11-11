import type { ReviewReport } from '@codeinsight/core/report/types';
import { shortSha } from '../format';

const INTENT_SOURCES = { arg: '参数', file: '文件', commits: '提交说明' } as const;

/** 报告概要：仓库、比较的两个版本、意图文本、耗时 */
export function ReportHeader({ report }: { report: ReviewReport }) {
  const { base, head, intent, timings } = report;
  const symbols = report.modules.reduce((n, m) => n + m.symbols.length, 0);
  return (
    <section className="panel report-header" data-testid="report-header">
      <h2>审查报告</h2>
      <div className="kv">
        <span>仓库</span>
        <code>{report.repo}</code>
        <span>比较</span>
        <span>
          <code>{base.ref}</code> ({shortSha(base.sha)}) → {head.working ? <code>工作区</code> : <code>{head.ref}</code>} ({shortSha(head.sha)})
        </span>
        <span>概况</span>
        <span>
          {report.files.length} 个文件，{symbols} 个函数级改动，{report.edgeChanges.length} 条调用边变化
          {timings ? `，耗时 ${(timings.totalMs / 1000).toFixed(1)}s` : ''}
        </span>
        {intent && (
          <>
            <span>意图（{INTENT_SOURCES[intent.source]}）</span>
            <pre className="intent-text">{intent.text}</pre>
          </>
        )}
      </div>
    </section>
  );
}
