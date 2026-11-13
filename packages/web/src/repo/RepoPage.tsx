import { OpenRepoForm } from './OpenRepoForm';
import { RecentRepos } from './RecentRepos';
import { useOpenRepo } from './useOpenRepo';

/** 没有打开仓库时的内容区：输入路径或选择目录打开，下方是最近使用的仓库 */
export function RepoPage({ dirPickerAvailable, onOpened }: { dirPickerAvailable: boolean; onOpened(): void }) {
  const opener = useOpenRepo(onOpened);
  return (
    <section className="panel repo-page" data-testid="repo-page">
      <h3>选择仓库</h3>
      <p className="muted">选择一个 git 仓库开始分析，打开后会先建索引。</p>
      <OpenRepoForm opener={opener} dirPickerAvailable={dirPickerAvailable} />
      <h4>最近使用</h4>
      <RecentRepos disabled={opener.busy} onOpen={(p) => void opener.open(p)} />
    </section>
  );
}
