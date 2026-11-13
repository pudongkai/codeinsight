import type { StatusResponse } from '../api/types';

/** 可写范围的说明，如“当前仓库、notes（仅新建）” */
export function writeScopeText(scope: NonNullable<StatusResponse['writeScope']>): string {
  return ['当前仓库', ...scope.dirs.map((d) => `${d}（仅新建）`)].join('、');
}

/** 输入框上方的写入范围说明；没有当前仓库时不显示 */
export function WriteScopeNote({ scope }: { scope: StatusResponse['writeScope'] }) {
  if (!scope?.repo) return null;
  return (
    <p className="muted write-scope-note" data-testid="write-scope">
      可写：{writeScopeText(scope)}。助手提出的修改要在页面上确认后才会写入；其他可写目录由启动参数 --add-dir 指定。
    </p>
  );
}
