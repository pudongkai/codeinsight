import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { SettingsResponse } from '../src/api/types';
import { SettingsDialog } from '../src/settings/SettingsDialog';

function settings(extra: Partial<SettingsResponse['llm']> = {}, rest: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    path: '/home/me/.codeinsight/settings.json',
    llm: {
      provider: { value: 'openai-compatible', source: 'user' },
      baseUrl: { value: 'https://api.example.com/v1', source: 'user' },
      model: { value: 'gpt-x', source: 'env', env: 'CODEINSIGHT_LLM_MODEL' },
      apiKey: { set: true, last4: 'a1b2', source: 'user' },
      shadowed: [{ field: 'baseUrl', by: 'user', env: 'CODEINSIGHT_LLM_BASE_URL' }],
      ...extra,
    },
    effective: { configured: true, provider: 'openai-compatible', model: 'gpt-x', problem: null },
    autoReindex: false,
    ...rest,
  };
}

function renderDialog(s: SettingsResponse = settings()) {
  vi.spyOn(api, 'settings').mockResolvedValue(s);
  const onSaved = vi.fn();
  render(<SettingsDialog onClose={() => undefined} onSaved={onSaved} />);
  return { onSaved };
}

const input = (id: string) => screen.getByTestId<HTMLInputElement>(id);

describe('SettingsDialog', () => {
  it('shows where each value comes from, the shadowed env var, and only the last 4 characters of the key', async () => {
    renderDialog();
    await screen.findByTestId('settings-provider');
    expect(screen.getByTestId('settings-provider-source').textContent).toContain('用户设置');
    expect(screen.getByTestId('settings-model-source').textContent).toContain('环境变量 CODEINSIGHT_LLM_MODEL');
    expect(screen.getByTestId('settings-baseUrl-shadowed').textContent).toBe('环境变量 CODEINSIGHT_LLM_BASE_URL 也设置了，当前使用用户设置');
    // 用户设置的值填进输入框；其他来源的值只放在提示里
    expect(input('settings-baseUrl').value).toBe('https://api.example.com/v1');
    expect(input('settings-model').value).toBe('');
    expect(input('settings-model').placeholder).toBe('gpt-x（环境变量 CODEINSIGHT_LLM_MODEL）');
    const key = input('settings-apiKey');
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(key.placeholder).toBe('已设置（来自用户设置，末 4 位 a1b2）留空不修改');
  });

  it('saving with an empty key field does not send a key; the status is refreshed', async () => {
    const save = vi.spyOn(api, 'saveLlmSettings').mockResolvedValue(settings());
    const { onSaved } = renderDialog();
    fireEvent.change(await screen.findByTestId('settings-model'), { target: { value: 'gpt-y' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-y', apiKey: '', clearApiKey: false,
    }));
    expect((await screen.findByTestId('settings-message')).textContent).toBe('已保存');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('"清除" sends clearApiKey and empties the key field', async () => {
    const save = vi.spyOn(api, 'saveLlmSettings').mockResolvedValue(settings({ apiKey: { set: false, source: 'none' } }));
    renderDialog();
    fireEvent.change(await screen.findByTestId('settings-apiKey'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTestId('settings-clearApiKey'));
    expect(input('settings-apiKey').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', clearApiKey: true })));
    await waitFor(() => expect(input('settings-apiKey').placeholder).toBe('未设置'));
  });

  it('the clear option only appears for a key saved in the user settings', async () => {
    renderDialog(settings({ apiKey: { set: true, last4: 'zz99', source: 'env', env: 'OPENAI_API_KEY' } }));
    expect((await screen.findByTestId<HTMLInputElement>('settings-apiKey')).placeholder).toBe('已设置（来自环境变量 OPENAI_API_KEY，末 4 位 zz99）留空不修改');
    expect(screen.queryByTestId('settings-clearApiKey')).toBeNull();
  });

  it('shows the connection test result: success with time, failure with a readable reason', async () => {
    const test = vi.spyOn(api, 'testLlm')
      .mockResolvedValueOnce({ ok: true, provider: 'openai-compatible', model: 'gpt-x', origin: 'https://api.example.com', ms: 230 })
      .mockResolvedValueOnce({ ok: false, reason: 'auth', message: 'HTTP 401', ms: 80 });
    renderDialog();
    fireEvent.click(await screen.findByTestId('settings-test'));
    expect((await screen.findByTestId('settings-test-result')).textContent).toBe('连接成功：openai-compatible（gpt-x），https://api.example.com，用时 230 ms');
    fireEvent.click(screen.getByTestId('settings-test'));
    await waitFor(() => expect(screen.getByTestId('settings-test-result').textContent).toBe('连接失败：认证失败，检查 API key 是否正确。HTTP 401'));
    expect(test.mock.calls[0]![0]).toMatchObject({ apiKey: '', provider: 'openai-compatible' });
  });

  it('a failed save shows the reason; "恢复为环境变量配置" calls DELETE; the auto reindex switch saves right away', async () => {
    vi.spyOn(api, 'saveLlmSettings').mockRejectedValue(new Error('invalid_param: baseUrl must be a valid URL'));
    const reset = vi.spyOn(api, 'resetLlmSettings').mockResolvedValue(settings({ provider: { value: 'anthropic', source: 'env', env: 'CODEINSIGHT_LLM_PROVIDER' } }));
    const general = vi.spyOn(api, 'saveGeneralSettings').mockResolvedValue(settings({}, { autoReindex: true }));
    renderDialog();
    fireEvent.click(await screen.findByTestId('settings-save'));
    expect((await screen.findByTestId('settings-message')).textContent).toBe('保存失败：invalid_param: baseUrl must be a valid URL');
    fireEvent.click(screen.getByTestId('settings-reset'));
    await waitFor(() => expect(screen.getByTestId('settings-provider-source').textContent).toContain('环境变量 CODEINSIGHT_LLM_PROVIDER'));
    expect(reset).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('settings-autoReindex'));
    await waitFor(() => expect(input('settings-autoReindex').checked).toBe(true));
    expect(general).toHaveBeenCalledWith({ autoReindex: true });
  });
});
