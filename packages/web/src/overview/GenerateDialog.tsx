import { useState } from 'react';
import { api } from '../api/client';
import type { OverviewEstimate, OverviewParams, StatusResponse } from '../api/types';
import { useApi } from '../browse/useApi';
import type { StartResult } from './useOverviewJob';

interface Props {
  status: StatusResponse;
  onStart(params: OverviewParams, confirmed: boolean): Promise<StartResult>;
  onClose(): void;
}

export const LLM_SETUP_HELP =
  '配置方法：启动 serve 前设置环境变量 CODEINSIGHT_LLM_PROVIDER（anthropic 或 openai-compatible）、CODEINSIGHT_LLM_API_KEY，' +
  '需要时再设置 CODEINSIGHT_LLM_BASE_URL、CODEINSIGHT_LLM_MODEL，然后重启 serve。';

function estimateText(e: OverviewEstimate): string {
  const to = `${e.provider ?? ''}（${e.model ?? ''}）`;
  if (e.llmCalls === 0) return `AI 说明全部命中缓存（${e.cachedCalls} 次），不会发送请求到 ${to}。`;
  return `将发送结构信息（${e.sendSource ? '含' : '不含'}源码片段）到 ${to}，预计 ${e.llmCalls} 次请求，约 ${e.inputTokens} 输入 token（${e.cachedCalls} 次命中缓存）。`;
}

/** 源码片段开关：配置或环境变量已关闭时禁用并说明 */
function SourceToggle({ allowed, noSource, onChange }: { allowed: boolean; noSource: boolean; onChange(v: boolean): void }) {
  return (
    <label>
      <input type="checkbox" data-testid="overview-no-source" checked={!allowed || noSource} disabled={!allowed} onChange={(e) => onChange(e.target.checked)} /> 不发送源码片段
      {!allowed && <span className="muted">（已由仓库配置或环境变量 CODEINSIGHT_SEND_SOURCE 关闭）</span>}
    </label>
  );
}

/** 配置了 LLM 时：打开弹窗才估算，切换源码开关时重新估算；超过阈值时按钮变为“仍然生成” */
function LlmBody({ status, onStart, onClose }: Props) {
  const [noSource, setNoSource] = useState(!status.sendSource);
  const [confirmEst, setConfirmEst] = useState<{ noSource: boolean; estimate: OverviewEstimate }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const est = useApi(() => api.overviewEstimate({ noSource }), [noSource]);
  const shown = confirmEst?.noSource === noSource ? confirmEst.estimate : est.data;
  const submit = async () => {
    setBusy(true);
    const r = await onStart({ noSource }, shown?.needsConfirm ?? false);
    setBusy(false);
    if (r.kind === 'needs_confirm') setConfirmEst({ noSource, estimate: r.estimate });
    else if (r.kind === 'failed') setError(r.error);
    else onClose();
  };
  return (
    <>
      {est.loading && <p className="muted">正在估算请求次数和 token…</p>}
      {est.error && <div className="error">估算失败：{est.error}</div>}
      {shown && <p data-testid="overview-estimate">{estimateText(shown)}</p>}
      {shown?.needsConfirm && <p className="warn" data-testid="overview-needs-confirm">预计输入 token 超过确认阈值（overview.confirmTokens），确认后再生成。</p>}
      <SourceToggle allowed={status.sendSource} noSource={noSource} onChange={setNoSource} />
      {error && <div className="error" data-testid="overview-start-error">{error}</div>}
      <div className="actions">
        <button type="button" className="small" onClick={onClose}>取消</button>
        <button type="button" className="primary" data-testid="overview-confirm" disabled={busy || !shown} onClick={() => void submit()}>
          {shown?.needsConfirm ? '仍然生成' : '生成'}
        </button>
      </div>
    </>
  );
}

/** 未配置 LLM：只生成结构部分，说明如何配置 */
function NoLlmBody({ onStart, onClose }: Props) {
  const [error, setError] = useState<string>();
  const submit = async () => {
    const r = await onStart({}, false);
    if (r.kind === 'started') onClose();
    else setError(r.kind === 'failed' ? r.error : '需要确认后再生成');
  };
  return (
    <>
      <p>未配置 LLM：只生成结构部分（模块、依赖、外部依赖、功能分组、边界问题），名称用目录名，不发送任何代码。</p>
      <p className="muted" data-testid="llm-setup-help">{LLM_SETUP_HELP}</p>
      {error && <div className="error" data-testid="overview-start-error">{error}</div>}
      <div className="actions">
        <button type="button" className="small" onClick={onClose}>取消</button>
        <button type="button" className="primary" data-testid="overview-confirm" onClick={() => void submit()}>生成结构概览（未配置 LLM）</button>
      </div>
    </>
  );
}

/** 生成概览的弹窗：显示估算和发送范围，确认后发起 */
export function GenerateDialog(props: Props) {
  return (
    <div className="modal-backdrop">
      <div className="panel modal" role="dialog" aria-label="生成概览" data-testid="overview-dialog">
        <h3>生成概览</h3>
        {props.status.llm ? <LlmBody {...props} /> : <NoLlmBody {...props} />}
      </div>
    </div>
  );
}
