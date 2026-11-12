import { symbolMarks, type Mark, type MarkSource } from './marks';

export function MarkTag({ mark }: { mark: Mark }) {
  return (
    <span className={`mark mark-${mark.kind}`} data-testid="symbol-mark" data-mark={mark.kind} title={mark.title}>
      {mark.label}
    </span>
  );
}

/** 符号的类型标记（接口 / 模型 / 方法），没有标记时不渲染 */
export function SymbolMarks({ symbol }: { symbol: MarkSource }) {
  const marks = symbolMarks(symbol);
  if (marks.length === 0) return null;
  return (
    <span className="marks">
      {marks.map((m) => <MarkTag key={m.kind} mark={m} />)}
    </span>
  );
}
