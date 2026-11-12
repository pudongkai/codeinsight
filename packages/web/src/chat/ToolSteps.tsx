import type { ToolStep } from './answer';
import { TOOL_ERROR_LABELS, toolLabel } from './tool-labels';

function stepState(t: ToolStep): string {
  if (t.error) return `（${TOOL_ERROR_LABELS[t.error] ?? t.error}）`;
  return t.done ? '' : '…';
}

/** 工具调用进度：一行一条，可折叠；正在回答时展开 */
export function ToolSteps({ tools, answering }: { tools: ToolStep[]; answering: boolean }) {
  if (tools.length === 0) return null;
  return (
    <details className="tool-steps" data-testid="tool-steps" open={answering || undefined}>
      <summary>查询了 {tools.length} 次代码索引</summary>
      <ul>
        {tools.map((t, i) => (
          <li key={i} data-testid="tool-step" data-name={t.name} data-done={t.done} className={t.error ? 'warn' : undefined}>
            {toolLabel(t.name, t.args)}{stepState(t)}
          </li>
        ))}
      </ul>
    </details>
  );
}
