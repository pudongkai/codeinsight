import type { FileChange } from '@codeinsight/core/report/types';

const SUPPORT = { full: '结构 + 调用', structure: '仅结构', none: '仅文件级' } as const;

/** 全部改动文件（含不支持的语言） */
export function FileList({ files }: { files: FileChange[] }) {
  return (
    <section className="panel" data-testid="file-list">
      <h3>改动文件（{files.length}）</h3>
      <table className="table">
        <thead>
          <tr>
            <th>状态</th>
            <th>路径</th>
            <th>语言</th>
            <th>分析</th>
            <th>行</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path}>
              <td>{f.status}</td>
              <td>
                <code>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</code> {f.isTest && <span className="tag">测试</span>}
              </td>
              <td>{f.language}</td>
              <td>{SUPPORT[f.supportLevel]}</td>
              <td>
                <span className="plus">+{f.additions}</span> <span className="minus">-{f.deletions}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
