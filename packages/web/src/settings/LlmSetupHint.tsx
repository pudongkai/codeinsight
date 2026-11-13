import { api } from '../api/client';
import { useApi } from '../browse/useApi';
import { useOpenSettings } from './context';

/**
 * 未配置模型服务时的引导：“打开设置”入口，配置有误时显示原因，下方一行小字说明也可以用环境变量配置。
 * what 是不能做的事，如“，不能使用问答”。
 */
export function LlmSetupHint({ what = '' }: { what?: string }) {
  const open = useOpenSettings();
  // 原因只在设置接口里有；读不到时不显示原因
  const settings = useApi(() => api.settings(), []);
  const problem = settings.data?.effective.problem;
  return (
    <>
      <span data-testid="llm-setup">
        未配置模型服务{what}。
        {open && <button type="button" className="link" data-testid="open-settings" onClick={open}>打开设置</button>}
      </span>
      {problem && <div className="warn" data-testid="llm-problem">配置有问题：{problem}</div>}
      <div className="muted small-note" data-testid="llm-setup-help">也可以用环境变量 CODEINSIGHT_LLM_PROVIDER 等配置</div>
    </>
  );
}
