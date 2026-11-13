import type { LlmSourceKind, LlmTestResult, SettingsResponse } from '../api/types';

const SOURCE_LABELS: Record<LlmSourceKind, string> = {
  user: '用户设置',
  env: '环境变量',
  repo: '仓库配置',
  default: '默认值',
  none: '未设置',
};

/** 来源的中文说明，环境变量带上变量名，如“环境变量 CODEINSIGHT_LLM_MODEL” */
export function sourceText(f: { source: LlmSourceKind; env?: string }): string {
  return f.source === 'env' && f.env ? `环境变量 ${f.env}` : SOURCE_LABELS[f.source];
}

const TEST_REASONS: Record<string, string> = {
  missing_key: '没有 API key',
  invalid_config: '配置不完整',
  auth: '认证失败，检查 API key 是否正确',
  not_found: '地址或模型不存在（404），检查服务地址和模型名',
  rate_limited: '请求太频繁或额度不足（429）',
  timeout: '连接超时',
  network: '连不上服务，检查服务地址和网络',
  bad_response: '服务返回的内容格式不对',
};

/** 测试连接结果的说明：成功时带耗时，失败时带原因和服务端的错误信息 */
export function testResultText(r: LlmTestResult): string {
  if (r.ok) return `连接成功：${r.provider}（${r.model}），${r.origin}，用时 ${r.ms} ms`;
  const http = /^http_(\d+)$/.exec(r.reason);
  const reason = TEST_REASONS[r.reason] ?? (http ? `服务返回 HTTP ${http[1]}` : r.reason);
  return `连接失败：${reason}。${r.message}`;
}

/** apiKey 输入框的提示：已设置时只给来源和末 4 位，不显示原文 */
export function apiKeyPlaceholder(k: SettingsResponse['llm']['apiKey']): string {
  if (!k.set) return '未设置';
  const tail = k.last4 ? `，末 4 位 ${k.last4}` : '';
  return `已设置（来自${sourceText(k)}${tail}）留空不修改`;
}
