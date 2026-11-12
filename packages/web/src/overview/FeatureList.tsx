import type { Feature, FeatureEntry, OverviewModule } from '@codeinsight/core/overview/types';
import { groupBy } from '@codeinsight/core/util/collections';
import type { CurrentLinks } from '../app/useCurrentLinks';
import { SymbolMarks } from '../marks/SymbolMarks';

/** 点击接口打开邻居图时预先展开的被调用方层数 */
export const FEATURE_CALLEE_DEPTH = 2;

function entryLabel(e: FeatureEntry): string {
  if (e.method || e.path) return `${e.method ?? ''} ${e.path ?? ''}`.trim();
  return `${e.kind} ${e.symbol.qualifiedName}`;
}

/** 一个功能：名称、说明、入口；点击入口以处理函数为中心打开邻居图并展开被调用方 */
export function FeatureItem({ feature, links }: { feature: Feature; links: CurrentLinks }) {
  return (
    <div className="feature" data-testid="feature" data-id={feature.id}>
      <h4>{feature.name}</h4>
      {feature.description && <p className="muted">{feature.description}</p>}
      <ul>
        {feature.entries.map((e) => (
          <li key={`${e.symbol.id}:${entryLabel(e)}`}>
            <button type="button" className="link" data-testid="feature-entry" data-symbol={e.symbol.id}
              onClick={() => links.openGraph(e.symbol, { expandCallees: FEATURE_CALLEE_DEPTH })}>
              {entryLabel(e)}
            </button>{' '}
            <SymbolMarks symbol={e.symbol} />
            <span className="muted">{e.symbol.qualifiedName}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 功能清单，按模块分组（模块顺序同模块列表） */
export function FeatureList({ features, modules, links }: { features: Feature[]; modules: OverviewModule[]; links: CurrentLinks }) {
  const byModule = groupBy(features, (f) => f.module);
  const names = new Map(modules.map((m) => [m.id, m.name]));
  const order = [...byModule.keys()].sort((a, b) => modules.findIndex((m) => m.id === a) - modules.findIndex((m) => m.id === b));
  return (
    <section data-testid="feature-list">
      {features.length === 0 && <p className="muted">没有识别到接口或其他入口。</p>}
      {order.map((id) => (
        <div key={id} className="panel" data-testid="feature-group" data-module={id}>
          <h3>{names.get(id) ?? id} <span className="mod-id muted">{id}</span></h3>
          {byModule.get(id)!.map((f) => <FeatureItem key={f.id} feature={f} links={links} />)}
        </div>
      ))}
    </section>
  );
}
