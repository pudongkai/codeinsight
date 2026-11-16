import type { LlmTestResult, SettingsResponse } from '../api/types';
import { providerName } from './model-label';

const TEST_REASONS: Record<string, string> = {
  missing_key: '没有 API key',
  invalid_config: '配置不完整',
  auth: '认证失败，检查 API key 是否正确',
  not_found: '地址或模型不存在（404），检查服务地址和模型名',
  rate_limited: '请求太频繁或额度不足（429）',
  timeout: '连接超时',
  network: '连不上服务，检查服务地址和网络',
  bad_response: '服务返回的内容格式不对',
  command_not_found: '找不到命令，请填写可执行文件的路径（或设置环境变量 CODEINSIGHT_LLM_COMMAND）',
  not_executable: '命令不能执行，检查文件权限（Windows 上请填 .exe 文件的路径）',
  version_failed: '运行 --version 失败，检查命令路径是否指向正确的程序',
  not_logged_in: '本机 CLI 未登录，请在终端运行 claude（或 opencode auth login）登录',
  quota: '账号额度已用完',
  model_not_found: '模型不存在，检查模型名',
  invalid_request: '请求被拒绝，检查模型名',
  server_error: '模型服务繁忙，稍后再试',
  cli_failed: '本机 CLI 运行出错',
  context_overflow: '输入超出模型的长度上限',
  content_filtered: '内容被模型服务拦截',
};

/** 测试连接结果的说明：成功时带耗时，失败时带原因和服务端的错误信息；本机 CLI 成功时带版本和实际模型 */
export function testResultText(r: LlmTestResult): string {
  if (r.ok && 'version' in r) return `连接成功：${providerName(r.provider)} ${r.version}，模型 ${r.model || '工具默认模型'}，用时 ${r.ms} ms`;
  if (r.ok) return `连接成功：${r.provider}（${r.model}），${r.origin}，用时 ${r.ms} ms`;
  const http = /^http_(\d+)$/.exec(r.reason);
  const reason = TEST_REASONS[r.reason] ?? (http ? `服务返回 HTTP ${http[1]}` : r.reason);
  return `连接失败：${reason}。${r.message}`;
}

/** apiKey 输入框的提示：已设置时只给来源和末 4 位，不显示原文 */
export function apiKeyPlaceholder(k: SettingsResponse['llm']['apiKey']): string {
  if (!k.set) return '未设置';
  return k.last4 ? `已设置（末 4 位 ${k.last4}），留空不修改` : '已设置，留空不修改';
}
