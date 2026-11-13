import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { LlmForm, LlmTestResult, SettingsResponse } from '../api/types';

type Action = 'save' | 'test' | 'general';

const ACTION_LABELS: Record<Action, string> = { save: '保存', test: '测试连接', general: '保存索引设置' };

/**
 * 表单初值：只填用户设置里保存的项（留空表示不保存，用环境变量或默认值），其他来源的值放在输入框提示里；
 * apiKey 永远为空（留空不修改）。
 */
export function formFrom(s: SettingsResponse): LlmForm {
  const saved = (f: { value: string | null; source: string }) => (f.source === 'user' ? (f.value ?? '') : '');
  return {
    provider: s.llm.provider.value === 'openai-compatible' ? 'openai-compatible' : 'anthropic',
    baseUrl: saved(s.llm.baseUrl),
    model: saved(s.llm.model),
    apiKey: '',
    clearApiKey: false,
  };
}

/** 设置对话框的数据和操作：读取、编辑、保存、测试连接、自动更新索引开关；每个操作失败时给出原因 */
export function useSettingsForm(onSaved: () => void) {
  const [view, setView] = useState<SettingsResponse>();
  const [form, setForm] = useState<LlmForm>();
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
    update: (patch: Partial<LlmForm>) => setForm((f) => f && { ...f, ...patch }),
    save: () => form && run('save', async () => saved(await api.saveLlmSettings(form), '已保存')),
    testConnection: () => form && run('test', async () => {
      setTest(undefined);
      setTest(await api.testLlm(form));
    }),
    setAutoReindex: (autoReindex: boolean) => run('general', async () => {
      setView(await api.saveGeneralSettings({ autoReindex }));
      onSaved();
    }),
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
