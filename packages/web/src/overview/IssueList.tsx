import type { BoundaryIssue, BoundaryIssueKind } from '@codeinsight/core/overview/types';
import { groupBy } from '@codeinsight/core/util/collections';
import type { CurrentLinks } from '../app/useCurrentLinks';
import { ISSUE_LABELS } from './labels';
import { SampleList } from './parts';

/** 一条边界问题：涉及模块、说明、示例调用点 */
export function IssueItem({ issue, links }: { issue: BoundaryIssue; links: CurrentLinks }) {
  return (
    <div className="issue" data-testid="issue" data-kind={issue.kind}>
      <p className={issue.severity === 'warning' ? 'issue-warning' : ''}>
        {issue.modules.map((m) => <code key={m} className="tag">{m}</code>)} {issue.message}
      </p>
      <SampleList samples={issue.samples} links={links} />
    </div>
  );
}

const KIND_ORDER = Object.keys(ISSUE_LABELS) as BoundaryIssueKind[];

/** 边界问题，按类型分组 */
export function IssueList({ issues, links }: { issues: BoundaryIssue[]; links: CurrentLinks }) {
  const byKind = groupBy(issues, (i) => i.kind);
  return (
    <section data-testid="issue-list">
      {issues.length === 0 && <p className="muted">没有发现边界问题。</p>}
      {KIND_ORDER.filter((k) => byKind.has(k)).map((k) => (
        <div key={k} className="panel" data-testid="issue-group" data-kind={k}>
          <h3>{ISSUE_LABELS[k]}（{byKind.get(k)!.length}）</h3>
          {byKind.get(k)!.map((i, n) => <IssueItem key={n} issue={i} links={links} />)}
        </div>
      ))}
    </section>
  );
}
