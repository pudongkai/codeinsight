/** 概览页的显示文字：外部依赖类别、AI 说明状态、边界问题类型、生成步骤 */
import type { BoundaryIssueKind, ExternalCategory, ModuleAiStatus } from '@codeinsight/core/overview/types';
import type { OverviewStep } from '../api/types';

export const CATEGORY_LABELS: Record<ExternalCategory, { label: string; short: string }> = {
  database: { label: '数据库', short: '库' },
  cache: { label: '缓存', short: '缓存' },
  http_client: { label: 'HTTP 客户端', short: 'HTTP' },
  message_queue: { label: '消息队列', short: 'MQ' },
  email: { label: '邮件', short: '邮件' },
  payment: { label: '支付', short: '支付' },
  storage: { label: '对象存储', short: '存储' },
  auth_crypto: { label: '认证与加密', short: '鉴权' },
  llm: { label: 'LLM', short: 'LLM' },
  web_framework: { label: 'Web 框架', short: 'Web' },
  subprocess: { label: '子进程', short: '进程' },
  other: { label: '其他', short: '其他' },
};

/** 模块 AI 说明的状态：文字和是否算问题（失败、跳过、截断用醒目颜色） */
export const AI_STATUS: Record<ModuleAiStatus, { label: string; title: string; problem: boolean }> = {
  ok: { label: 'AI', title: '名称和职责由本次 AI 请求生成', problem: false },
  cached: { label: 'AI·缓存', title: '名称和职责来自缓存（输入没有变化，未重新请求）', problem: false },
  truncated: { label: 'AI·输入截断', title: '模块太大，发送给 AI 的输入被截断，说明可能不完整', problem: true },
  failed: { label: 'AI 失败', title: 'AI 请求失败，名称用目录名', problem: true },
  skipped: { label: 'AI 已跳过', title: '失败的请求过多，后续请求已停止，名称用目录名', problem: true },
  none: { label: '无 AI', title: '没有请求 AI（未配置 LLM 或只生成结构部分），名称用目录名', problem: false },
};

export const ISSUE_LABELS: Record<BoundaryIssueKind, string> = {
  cycle: '模块循环依赖',
  layer_violation: '跨层调用',
  layer_skip: '跳过业务层',
  private_access: '访问其他模块的私有函数',
};

export const STEP_LABELS: Record<OverviewStep, string> = {
  partition: '划分模块、整理结构',
  modules: '生成模块说明',
  features: '为功能命名',
  system: '生成系统简介',
};
