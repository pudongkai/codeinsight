import { isCliProvider } from '@codeinsight/core/settings/types';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ExtraEnvEntry, LlmForm, LlmProvider, LlmTestResult, SettingsResponse } from '../api/types';

type Action = 'save' | 'test' | 'general';

const ACTION_LABELS: Record<Action, string> = { save: '保存', test: '测试连接', general: '保存索引设置' };

const PROVIDERS: LlmProvider[] = ['anthropic', 'openai-compatible', 'claude-code', 'opencode'];

/**
 * 附加环境变量的一行。hidden 的行是接口没有返回原值的已保存项（不回传值，或值去掉了账号密码等）：
 * 值留空表示沿用已保存的值，shown 是接口给出的去掉敏感部分后的值。
 */
export interface EnvRow {
  name: string;
  value: string;
  hidden: boolean;
  shown?: string;
}

/** 对话框里编辑的表单：LlmForm 的 API 部分加上本机 CLI 的命令路径和附加环境变量 */
export interface EditForm extends Omit<LlmForm, 'command' | 'extraEnv'> {
  command: string;
  envRows: EnvRow[];
}

function envRowsFrom(s: SettingsResponse): EnvRow[] {
  if (s.llm.extraEnv?.source !== 'user') return [];
  return s.llm.extraEnv.entries.map((e) => {
    if ('set' in e) return { name: e.name, value: '', hidden: true };
    // 去掉过敏感部分的值不是原值，不能原样发回去，按隐藏的项处理
    return e.masked ? { name: e.name, value: '', hidden: true, shown: e.value } : { name: e.name, value: e.value, hidden: false };
  });
}

/** 当前生效、但暂不能选择的 provider（如环境变量设成了 opencode）；表单改用 anthropic，提示用户重新选择 */
export function unavailableEffectiveProvider(s: SettingsResponse): LlmProvider | undefined {
  const p = PROVIDERS.find((x) => x === s.llm.provider.value);
  return p && (s.unavailableProviders ?? []).includes(p) ? p : undefined;
}

/**
 * 表单初值：只填用户设置里保存的项（留空表示不保存，用环境变量或默认值），其他来源的值放在输入框提示里；
 * apiKey 永远为空（留空不修改）。生效的 provider 暂不可用时改为 anthropic，它的模型不带过来。
 */
export function formFrom(s: SettingsResponse): EditForm {
  const saved = (f: { value: string | null; source: string } | undefined) => (f?.source === 'user' ? (f.value ?? '') : '');
  const replaced = unavailableEffectiveProvider(s) !== undefined;
  const provider = replaced ? 'anthropic' : (PROVIDERS.find((p) => p === s.llm.provider.value) ?? 'anthropic');
  return {
    provider,
    baseUrl: saved(s.llm.baseUrl),
    model: replaced ? '' : saved(s.llm.model),
    apiKey: '',
    clearApiKey: false,
    command: saved(s.llm.command),
    envRows: envRowsFrom(s),
  };
}

function extraEnvOf(rows: EnvRow[]): ExtraEnvEntry[] {
  return rows.filter((r) => r.name.trim() !== '').map((r) => (r.hidden && r.value === '' ? { name: r.name.trim() } : { name: r.name.trim(), value: r.value }));
}

/** 发给接口的内容：API provider 只带服务地址、模型和 key；本机 CLI 不带服务地址和 key，带命令路径和完整的附加环境变量列表 */
export function payloadOf(f: EditForm): LlmForm {
  if (!isCliProvider(f.provider)) return { provider: f.provider, baseUrl: f.baseUrl, model: f.model, apiKey: f.apiKey, clearApiKey: f.clearApiKey };
  return { provider: f.provider, baseUrl: '', model: f.model, apiKey: '', clearApiKey: false, command: f.command, extraEnv: extraEnvOf(f.envRows) };
}

/** API 类和本机 CLI 类之间换 provider 时清空模型：两类的模型名不通用（如 gpt-4o 不能交给 claude） */
export function applyPatch(f: EditForm, patch: Partial<EditForm>): EditForm {
  const next = { ...f, ...patch };
  if (patch.provider !== undefined && isCliProvider(patch.provider) !== isCliProvider(f.provider)) next.model = '';
  return next;
}

/** 设置对话框的数据和操作：读取、编辑、保存、测试连接、自动更新索引开关；每个操作失败时给出原因 */
export function useSettingsForm(onSaved: () => void) {
  const [view, setView] = useState<SettingsResponse>();
  const [form, setForm] = useState<EditForm>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState<Action>();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const [test, setTest] = useState<LlmTestResult>();

  const apply = (s: SettingsResponse) => {
    setView(s);
    setForm(formFrom(s));
  };
  useEffect(() => {
    api.settings().then(apply, (err: unknown) => setLoadError(`读取设置失败：${errorMessage(err)}`));
  }, []);

  const run = async (action: Action, fn: () => Promise<void>) => {
    setBusy(action);
    setMessage(undefined);
    try {
      await fn();
    } catch (err) {
      setMessage({ ok: false, text: `${ACTION_LABELS[action]}失败：${errorMessage(err)}` });
    } finally {
      setBusy(undefined);
    }
  };
  const saved = (s: SettingsResponse, text: string) => {
    apply(s);
    setTest(undefined);
    setMessage({ ok: true, text });
    onSaved();
  };

  return {
    view, form, loadError, busy, message, test,
    update: (patch: Partial<EditForm>) => setForm((f) => f && applyPatch(f, patch)),
    save: () => form && run('save', async () => saved(await api.saveLlmSettings(payloadOf(form)), '已保存')),
    testConnection: () => form && run('test', async () => {
      setTest(undefined);
      setTest(await api.testLlm(payloadOf(form)));
    }),
    setAutoReindex: (autoReindex: boolean) => run('general', async () => {
      setView(await api.saveGeneralSettings({ autoReindex }));
      onSaved();
    }),
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
