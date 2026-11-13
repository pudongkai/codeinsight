import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { SettingsResponse } from '../src/api/types';
import { testResultText } from '../src/settings/labels';
import { llmLabel } from '../src/settings/model-label';
import { SettingsDialog } from '../src/settings/SettingsDialog';

/** 设置对话框里的本机 CLI：字段切换、附加环境变量编辑、提示文字 */

function apiSettings(): SettingsResponse {
  return {
    path: '/home/me/.codeinsight/settings.json',
    llm: {
      provider: { value: 'anthropic', source: 'user' },
      baseUrl: { value: 'https://gw.example.com', source: 'user' },
      model: { value: 'claude-x', source: 'user' },
      apiKey: { set: true, last4: 'a1b2', source: 'user' },
      command: { value: null, source: 'none', resolved: null },
      extraEnv: { source: 'none', entries: [] },
      shadowed: [],
    },
    effective: { configured: true, kind: 'api', provider: 'anthropic', model: 'claude-x', problem: null },
    unavailableProviders: ['opencode'],
    autoReindex: false,
  };
}

function cliSettings(): SettingsResponse {
  return {
    path: '/home/me/.codeinsight/settings.json',
    llm: {
      provider: { value: 'claude-code', source: 'user' },
      baseUrl: { value: null, source: 'none' },
      model: { value: null, source: 'none' },
      apiKey: { set: false, source: 'none' },
      command: { value: null, source: 'default', resolved: '/opt/homebrew/bin/claude' },
      extraEnv: {
        source: 'user',
        entries: [{ name: 'https_proxy', value: 'http://10.0.0.1:3128' }, { name: 'MY_TOKEN', set: true }, { name: 'ALL_PROXY', value: 'http://p.local:1080', masked: true }],
      },
      shadowed: [],
    },
    effective: { configured: true, kind: 'cli', provider: 'claude-code', model: '', problem: null },
    unavailableProviders: ['opencode'],
    autoReindex: false,
  };
}

function renderDialog(s: SettingsResponse) {
  vi.spyOn(api, 'settings').mockResolvedValue(s);
  render(<SettingsDialog onClose={() => undefined} onSaved={() => undefined} />);
}

const input = (id: string) => screen.getByTestId<HTMLInputElement>(id);

describe('SettingsDialog with a local CLI', () => {
  it('hides the service address and API key for Claude Code and warns that the saved key is dropped', async () => {
    renderDialog(apiSettings());
    const select = await screen.findByTestId<HTMLSelectElement>('settings-provider');
    expect(screen.getByTestId('settings-baseUrl')).toBeTruthy();
    expect(screen.queryByTestId('settings-test-note')).toBeNull();
    fireEvent.change(select, { target: { value: 'claude-code' } });
    expect(screen.queryByTestId('settings-baseUrl')).toBeNull();
    expect(screen.queryByTestId('settings-apiKey')).toBeNull();
    expect(input('settings-command').placeholder).toBe('留空则自动查找 claude');
    expect(input('settings-model').placeholder).toBe('留空使用工具默认模型');
    expect(screen.getByTestId('settings-key-drop').textContent).toContain('不再保留已保存的 API Key 和服务地址');
    expect(screen.getByTestId('settings-test-note').textContent).toBe('会真实调用一次本机 CLI，消耗少量额度');
    fireEvent.change(select, { target: { value: 'anthropic' } });
    expect(screen.getByTestId('settings-apiKey')).toBeTruthy();
  });

  it('clears the model when switching between an API provider and a local CLI, keeps it within the same kind', async () => {
    renderDialog(apiSettings());
    const select = await screen.findByTestId<HTMLSelectElement>('settings-provider');
    fireEvent.change(input('settings-model'), { target: { value: 'gpt-4o' } });
    fireEvent.change(select, { target: { value: 'openai-compatible' } });
    expect(input('settings-model').value).toBe('gpt-4o');
    fireEvent.change(select, { target: { value: 'claude-code' } });
    expect(input('settings-model').value).toBe('');
    fireEvent.change(input('settings-model'), { target: { value: 'claude-opus-x' } });
    fireEvent.change(select, { target: { value: 'anthropic' } });
    expect(input('settings-model').value).toBe('');
  });

  it('greys out opencode and explains why', async () => {
    renderDialog(apiSettings());
    await screen.findByTestId('settings-provider');
    const option = screen.getByRole<HTMLOptionElement>('option', { name: 'opencode（本机）' });
    expect(option.disabled).toBe(true);
    expect(screen.getByTestId('settings-provider-unavailable').textContent).toContain('暂不可用');
  });

  it('shows the resolved command and hidden values; saving keeps hidden values and sends no key or address', async () => {
    const save = vi.spyOn(api, 'saveLlmSettings').mockResolvedValue(cliSettings());
    renderDialog(cliSettings());
    expect((await screen.findByTestId<HTMLInputElement>('settings-command')).placeholder).toBe('/opt/homebrew/bin/claude');
    const values = screen.getAllByTestId<HTMLInputElement>('settings-env-value');
    expect(values.map((v) => v.value)).toEqual(['http://10.0.0.1:3128', '', '']);
    expect(values[1]!.placeholder).toBe('已设置（值不显示），留空不修改');
    expect(values[2]!.placeholder).toBe('http://p.local:1080（已去掉账号密码等），留空不修改');
    expect(screen.getAllByTestId<HTMLInputElement>('settings-env-name')[1]!.readOnly).toBe(true);

    fireEvent.click(screen.getAllByTestId('settings-env-remove')[0]!);
    fireEvent.click(screen.getByTestId('settings-env-add'));
    const names = screen.getAllByTestId('settings-env-name');
    fireEvent.change(names[2]!, { target: { value: 'NO_PROXY' } });
    fireEvent.change(screen.getAllByTestId('settings-env-value')[2]!, { target: { value: 'localhost' } });
    fireEvent.change(screen.getAllByTestId('settings-env-value')[1]!, { target: { value: 'http://u:new@p.local:1080' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      provider: 'claude-code', baseUrl: '', model: '', apiKey: '', clearApiKey: false, command: '',
      extraEnv: [{ name: 'MY_TOKEN' }, { name: 'ALL_PROXY', value: 'http://u:new@p.local:1080' }, { name: 'NO_PROXY', value: 'localhost' }],
    }));
  });

  it('shows the version and the actual model after a successful test, and readable reasons on failure', async () => {
    vi.spyOn(api, 'testLlm')
      .mockResolvedValueOnce({ ok: true, provider: 'claude-code', model: '', command: '/opt/homebrew/bin/claude', version: '2.1.318 (Claude Code)', ms: 6120 })
      .mockResolvedValueOnce({ ok: false, reason: 'not_logged_in', message: 'Not logged in', ms: 900 });
    renderDialog(cliSettings());
    fireEvent.click(await screen.findByTestId('settings-test'));
    expect((await screen.findByTestId('settings-test-result')).textContent).toBe('连接成功：Claude Code 2.1.318 (Claude Code)，模型 工具默认模型，用时 6120 ms');
    fireEvent.click(screen.getByTestId('settings-test'));
    await waitFor(() => expect(screen.getByTestId('settings-test-result').textContent).toBe('连接失败：本机 CLI 未登录，请在终端运行 claude（或 opencode auth login）登录。Not logged in'));
  });
});

describe('labels', () => {
  it('llmLabel shows the default model and the quota note for local CLIs', () => {
    expect(llmLabel('anthropic', 'claude-x')).toBe('anthropic（claude-x）');
    expect(llmLabel('claude-code', '')).toBe('Claude Code（默认模型）（本机 CLI，使用你的订阅/账号额度）');
    expect(llmLabel('opencode', 'anthropic/claude-x')).toBe('opencode（anthropic/claude-x）（本机 CLI，使用你的订阅/账号额度）');
  });

  it('every new failure reason has a readable text', () => {
    for (const reason of ['command_not_found', 'not_executable', 'version_failed', 'not_logged_in', 'quota', 'rate_limited', 'model_not_found', 'timeout', 'cli_failed', 'bad_response']) {
      const text = testResultText({ ok: false, reason, message: 'm', ms: 1 });
      expect(text, reason).not.toContain(reason);
    }
  });

  it('names CODEINSIGHT_LLM_COMMAND in the command placeholder when it sets the command', async () => {
    const s = apiSettings();
    s.llm.commandEnv = '/opt/tools/claude';
    renderDialog(s);
    const select = await screen.findByTestId<HTMLSelectElement>('settings-provider');
    fireEvent.change(select, { target: { value: 'claude-code' } });
    expect(input('settings-command').placeholder).toBe('留空则使用环境变量 CODEINSIGHT_LLM_COMMAND 指定的 /opt/tools/claude');
  });

  it('starts from anthropic and asks to choose again when the effective provider is unavailable', async () => {
    const s = cliSettings();
    s.llm.provider = { value: 'opencode', source: 'env', env: 'CODEINSIGHT_LLM_PROVIDER' };
    s.llm.model = { value: 'some/model', source: 'user' };
    renderDialog(s);
    const select = await screen.findByTestId<HTMLSelectElement>('settings-provider');
    expect(select.value).toBe('anthropic');
    expect(input('settings-model').value).toBe('');
    expect(screen.getByTestId('settings-provider-replaced').textContent).toContain('opencode 暂不可用');
  });
});
