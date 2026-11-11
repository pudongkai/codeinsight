import type { ModuleChange, SymbolChange } from '@codeinsight/core/report/types';
import { CallerCounts, ChangeBadge, EntryTag } from './ChangeBadge';

interface Props {
  modules: ModuleChange[];
  selectedKey?: string;
  onSelect(change: SymbolChange): void;
}

function ChangeRow({ c, selected, onSelect }: { c: SymbolChange; selected: boolean; onSelect(c: SymbolChange): void }) {
  return (
    <li className={`change-row${selected ? ' selected' : ''}`} data-testid="change-row" data-change={c.change} data-name={c.qualifiedName} onClick={() => onSelect(c)}>
      <ChangeBadge change={c.change} />
      <span className="qname">{c.qualifiedName}</span>
      {c.isTest && <span className="tag">测试</span>}
      <EntryTag entry={c.entry} />
      <CallerCounts c={c} />
      <span className="loc">
        {c.path}:{c.startLine}
      </span>
    </li>
  );
}

/** 按模块分组的函数级改动清单 */
export function ChangeList({ modules, selectedKey, onSelect }: Props) {
  return (
    <section className="panel" data-testid="change-list">
      <h3>改动清单</h3>
      {modules.length === 0 && <p className="muted">没有函数级改动（不支持的语言只出现在下面的文件列表里）。</p>}
      {modules.map((m) => (
        <div key={m.module} className="module" data-testid="change-module">
          <h4>
            {m.module || '(仓库根目录)'} <span className="muted">{m.symbols.length}</span>
          </h4>
          <ul>
            {m.symbols.map((c) => (
              <ChangeRow key={`${c.change}:${c.key}`} c={c} selected={c.key === selectedKey} onSelect={onSelect} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
