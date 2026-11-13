import { isWriteTool, type ProposalView } from '@codeinsight/core/ask/events';
import type { ToolStep } from './answer';
import { TOOL_ERROR_LABELS, toolLabel } from './tool-labels';

function stepState(t: ToolStep): string {
  if (t.error) return `（${TOOL_ERROR_LABELS[t.error] ?? t.error}）`;
  return t.done ? '' : '…';
}

/**
 * 标题：查询次数和待确认修改分开说，如“查询了 5 次代码索引，生成了 1 个待确认修改”。
 * 几次写调用可能合并成一张卡片，所以生成的个数按回答收到的卡片算（proposals 为 undefined 表示还在回答，卡片还没到）；
 * 保存时没能生成的卡片和工具报错的调用算作没能生成
 */
export function stepsTitle(tools: ToolStep[], proposals?: readonly ProposalView[]): string {
  const writes = tools.filter((t) => isWriteTool(t.name));
  const reads = tools.length - writes.length;
  const pendingWrites = proposals === undefined && writes.some((t) => t.done && !t.error);
  const made = proposals?.filter((p) => !p.unbuilt).length ?? 0;
  const failed = writes.filter((t) => t.error).length + (proposals?.filter((p) => p.unbuilt).length ?? 0);
  const parts = [
    reads > 0 ? `查询了 ${reads} 次代码索引` : '',
    pendingWrites ? '正在生成待确认修改' : '',
    made > 0 ? `生成了 ${made} 个待确认修改` : '',
    failed > 0 ? `${failed} 个修改没能生成` : '',
  ];
  return parts.filter(Boolean).join('，');
}

/** 工具调用进度：一行一条，可折叠；正在回答时展开 */
export function ToolSteps({ tools, answering, proposals }: { tools: ToolStep[]; answering: boolean; proposals: readonly ProposalView[] }) {
  if (tools.length === 0) return null;
  return (
    <details className="tool-steps" data-testid="tool-steps" open={answering || undefined}>
      <summary>{stepsTitle(tools, answering ? undefined : proposals)}</summary>
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
