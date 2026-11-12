import type { ModuleEdge, OverviewModule, OverviewReport } from '@codeinsight/core/overview/types';
import type { ReactNode } from 'react';
import type { CurrentLinks } from '../app/useCurrentLinks';
import { EnvVarList } from './ExternalList';
import { FeatureItem } from './FeatureList';
import { IssueItem } from './IssueList';
import { CATEGORY_LABELS } from './labels';
import { AiStatusTag, SymbolEntry } from './parts';

interface Props {
  report: OverviewReport;
  module: OverviewModule;
  links: CurrentLinks;
  onSelectModule(id: string): void;
}

/** 有内容时才显示的小节 */
function Section({ title, testId, show, children }: { title: string; testId: string; show: boolean; children: ReactNode }) {
  if (!show) return null;
  return <div className="detail-section" data-testid={testId}><h4>{title}</h4>{children}</div>;
}

function ExternalSection({ m }: { m: OverviewModule }) {
  return (
    <Section title="外部依赖" testId="module-external" show={m.external.length > 0 || m.envVars.length > 0}>
      <ul>
        {m.external.map((x) => (
          <li key={x.category} data-category={x.category}>
            {CATEGORY_LABELS[x.category].label}：<code>{x.libs.join('、')}</code> <span className="loc">{x.files.join('、')}</span>
          </li>
        ))}
      </ul>
      {m.envVars.length > 0 && <><div className="muted">环境变量</div><EnvVarList vars={m.envVars} /></>}
    </Section>
  );
}

function DepList({ edges, other, names, onSelect }: { edges: ModuleEdge[]; other: (e: ModuleEdge) => string; names: Map<string, string>; onSelect(id: string): void }) {
  return (
    <ul>
      {edges.map((e) => (
        <li key={other(e)}>
          <button type="button" className="link" onClick={() => onSelect(other(e))}>{names.get(other(e)) ?? other(e)}</button>{' '}
          <span className="muted">{other(e)} · {e.weight} 处调用{e.inCycle ? ' · 循环依赖' : ''}</span>
        </li>
      ))}
    </ul>
  );
}

function DepsSection({ report, m, onSelect }: { report: OverviewReport; m: OverviewModule; onSelect(id: string): void }) {
  const names = new Map(report.modules.map((x) => [x.id, x.name]));
  const out = report.moduleEdges.filter((e) => e.from === m.id && e.to !== m.id);
  const inc = report.moduleEdges.filter((e) => e.to === m.id && e.from !== m.id);
  return (
    <>
      <Section title={`依赖的模块（${out.length}）`} testId="module-deps-out" show={out.length > 0}><DepList edges={out} other={(e) => e.to} names={names} onSelect={onSelect} /></Section>
      <Section title={`被依赖（${inc.length}）`} testId="module-deps-in" show={inc.length > 0}><DepList edges={inc} other={(e) => e.from} names={names} onSelect={onSelect} /></Section>
    </>
  );
}

function SymbolsSection({ m, links }: { m: OverviewModule; links: CurrentLinks }) {
  return (
    <>
      <Section title={`对外接口（${m.interfaces.length}${m.httpApis > 0 ? `，其中 HTTP 接口共 ${m.httpApis} 个` : ''}）`} testId="module-interfaces" show={m.interfaces.length > 0}>
        <ul>
          {m.interfaces.map((i) => (
            <li key={i.symbol.id}>
              <SymbolEntry symbol={i.symbol} links={links} graph />
              <span className="muted"> · 被 {i.inbound} 处调用{i.fromModules.length > 0 ? `（${i.fromModules.join('、')}）` : ''}</span>
              {i.summary && <div className="muted">{i.summary}</div>}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`数据模型（${m.models.length}）`} testId="module-models" show={m.models.length > 0}>
        <ul>{m.models.map((x) => <li key={x.symbol.id}><SymbolEntry symbol={x.symbol} links={links} />{x.summary && <div className="muted">{x.summary}</div>}</li>)}</ul>
      </Section>
    </>
  );
}

/** 模块详情：职责、对外接口、模型、外部依赖和环境变量、上下游模块、功能、相关边界问题、文件 */
export function ModuleDetail({ report, module: m, links, onSelectModule }: Props) {
  const features = report.features.filter((f) => f.module === m.id);
  const issues = report.issues.filter((i) => i.modules.includes(m.id));
  return (
    <section className="panel" data-testid="module-detail" data-id={m.id}>
      <h3>{m.name} <AiStatusTag status={m.aiStatus} /></h3>
      <div className="muted"><code>{m.id}</code> · 规模 {m.size} · {m.lines} 行 · {m.files.length} 个文件</div>
      <p data-testid="module-responsibility">{m.responsibility ?? <span className="muted">没有 AI 生成的职责说明。</span>}</p>
      <SymbolsSection m={m} links={links} />
      <ExternalSection m={m} />
      <DepsSection report={report} m={m} onSelect={onSelectModule} />
      <Section title={`功能（${features.length}）`} testId="module-features" show={features.length > 0}>
        {features.map((f) => <FeatureItem key={f.id} feature={f} links={links} />)}
      </Section>
      <Section title={`边界问题（${issues.length}）`} testId="module-issues" show={issues.length > 0}>
        {issues.map((i, n) => <IssueItem key={n} issue={i} links={links} />)}
      </Section>
      <Section title={`文件（${m.files.length}）`} testId="module-files" show={m.files.length > 0}>
        <ul className="files">{m.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
      </Section>
    </section>
  );
}
