import type { ProposalFileDiff } from '../api/types';

/** 文件头、权限变化（mode）和二进制文件说明 */
const META_LINE = /^(\+\+\+|---|(old|new|deleted file|new file) mode |Binary files )/;

/** 一行 diff 的样式：文件头和权限变化灰、`@@` 灰、`+` 绿、`-` 红 */
function lineClass(line: string): string | undefined {
  if (META_LINE.test(line)) return 'diff-meta';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return undefined;
}

function DiffBody({ file }: { file: ProposalFileDiff }) {
  if (file.tooLarge) return <p className="muted" data-testid="diff-too-large">文件太大，不显示对比</p>;
  if (file.diff === '') return <p className="muted">内容没有变化</p>;
  const lines = file.diff.replace(/\n$/, '').split('\n');
  return (
    <pre className="diff-view" data-testid="diff-body">
      {lines.map((l, i) => <div key={i} className={lineClass(l)}>{l === '' ? ' ' : l}</div>)}
    </pre>
  );
}

/** 一个文件的统一 diff，按行着色 */
export function DiffView({ file }: { file: ProposalFileDiff }) {
  return (
    <div className="diff-file" data-testid="diff-file" data-path={file.path}>
      <div className="diff-path"><code>{file.path}</code>{file.isNew ? '（新建）' : file.deleted ? '（删除）' : ''}</div>
      {file.changedSinceProposal && <p className="warn" data-testid="diff-changed">生成修改后这个文件被改过，下面是和当前内容的对比</p>}
      <DiffBody file={file} />
    </div>
  );
}
