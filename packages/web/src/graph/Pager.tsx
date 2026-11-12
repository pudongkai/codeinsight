export interface PagerProps {
  /** 前缀文字，如"上游" */
  label: string;
  /** 从 0 开始 */
  page: number;
  pages: number;
  total: number;
  /** 因"显示模型"关闭而隐藏的模型个数 */
  hiddenModels?: number;
  onPage(page: number): void;
  testId?: string;
}

/** 图旁的翻页控件："第 x / y 页，共 n 个"；只有一页时只显示个数 */
export function Pager({ label, page, pages, total, hiddenModels = 0, onPage, testId }: PagerProps) {
  return (
    <span className="pager" data-testid={testId} data-total={total} data-page={page + 1} data-pages={pages}>
      <span className="pager-label">{label}</span>
      {pages > 1 && (
        <button type="button" className="small" data-testid="pager-prev" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button>
      )}
      <span data-testid="pager-text">{pages > 1 ? `第 ${page + 1} / ${pages} 页，共 ${total} 个` : `共 ${total} 个`}</span>
      {pages > 1 && (
        <button type="button" className="small" data-testid="pager-next" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>下一页</button>
      )}
      {hiddenModels > 0 && <span className="muted" data-testid="pager-hidden-models">已隐藏 {hiddenModels} 个模型</span>}
    </span>
  );
}
