import { location } from '../format';
import type { SymbolTarget } from './actions';

/** 可点击的函数名加位置；点击时由上层决定在 IDE 打开还是在页面显示源码 */
export function SymbolLink({ target, onOpen, label }: { target: SymbolTarget; onOpen: (t: SymbolTarget) => void; label?: string }) {
  return (
    <span className="symlink">
      <button type="button" className="link" data-testid="symbol-link" onClick={() => onOpen(target)}>
        {label ?? target.name}
      </button>
      <span className="loc">{location(target.path, target.startLine)}</span>
    </span>
  );
}
