import type { ExternalCategorySummary, OverviewModule } from '@codeinsight/core/overview/types';
import { CATEGORY_LABELS } from './labels';

/** 环境变量和读取它的文件 */
export function EnvVarList({ vars }: { vars: OverviewModule['envVars'] }) {
  return (
    <ul>
      {vars.map((v) => (
        <li key={v.name} data-testid="env-var"><code>{v.name}</code> <span className="loc">{v.files.join('、')}</span></li>
      ))}
    </ul>
  );
}

/** 外部依赖：按类别列出库和用到它的模块；环境变量按模块列出 */
export function ExternalList({ external, modules }: { external: ExternalCategorySummary[]; modules: OverviewModule[] }) {
  const withEnv = modules.filter((m) => m.envVars.length > 0);
  return (
    <section data-testid="external-list">
      <div className="panel">
        <h3>外部依赖</h3>
        {external.length === 0 && <p className="muted">没有识别到外部依赖。</p>}
        <table className="table">
          <thead><tr><th>类别</th><th>库</th><th>模块</th></tr></thead>
          <tbody>
            {external.map((x) => (
              <tr key={x.category} data-testid="external-row" data-category={x.category}>
                <td>{CATEGORY_LABELS[x.category].label}</td><td><code>{x.libs.join('、')}</code></td><td>{x.modules.join('、')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>环境变量</h3>
        {withEnv.length === 0 && <p className="muted">没有识别到读取的环境变量。</p>}
        {withEnv.map((m) => (
          <div key={m.id}><h4>{m.name} <span className="mod-id muted">{m.id}</span></h4><EnvVarList vars={m.envVars} /></div>
        ))}
      </div>
    </section>
  );
}
