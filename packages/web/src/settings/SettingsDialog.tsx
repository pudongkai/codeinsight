import { isCliProvider } from '@codeinsight/core/settings/types';
import type { LlmFieldView, LlmProvider, SettingsResponse } from '../api/types';
import { CliFields } from './CliFields';
import { apiKeyPlaceholder, sourceText, testResultText } from './labels';
import { Modal } from './Modal';
import { unavailableEffectiveProvider, useSettingsForm, type SettingsForm } from './useSettingsForm';

type Shadowed = SettingsResponse['llm']['shadowed'];

/** 来源说明和“环境变量也设置了”的提示 */
function SourceNote({ name, field, shadowed }: { name: string; field: { source: LlmFieldView['source']; env?: string }; shadowed: Shadowed }) {
  const sh = shadowed.find((x) => x.field === name);
  return (
    <div className="field-note" data-testid={`settings-${name}-source`}>
      <span className="muted">来源：{sourceText(field)}</span>
      {sh && <span className="warn" data-testid={`settings-${name}-shadowed`}>环境变量 {sh.env} 也设置了，当前使用用户设置</span>}
    </div>
  );
}

/** 输入框提示：不是用户设置的值时显示当前生效的值和来源 */
function placeholderOf(f: LlmFieldView): string {
  if (f.source === 'user') return '留空则用环境变量或默认值';
  return f.value ? `${f.value}（${sourceText(f)}）` : '未设置';
}

interface TextFieldProps {
  name: 'baseUrl' | 'model';
  label: string;
  s: SettingsForm;
  /** 不传时按当前生效的值和来源生成 */
  placeholder?: string;
  hint?: string;
}

function TextField({ name, label, s, placeholder, hint }: TextFieldProps) {
  const field = s.view!.llm[name];
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        <input data-testid={`settings-${name}`} value={s.form![name]} placeholder={placeholder ?? placeholderOf(field)} onChange={(e) => s.update(name === 'baseUrl' ? { baseUrl: e.target.value } : { model: e.target.value })} />
      </label>
      {hint && <div className="field-note muted" data-testid={`settings-${name}-hint`}>{hint}</div>}
      <SourceNote name={name} field={field} shadowed={s.view!.llm.shadowed} />
    </div>
  );
}

/** 本机 CLI 的模型：留空使用工具默认模型；opencode 另外说明模型名的格式 */
function CliModelField({ s }: { s: SettingsForm }) {
  const opencode = s.form!.provider === 'opencode';
  return <TextField name="model" label="模型" s={s} placeholder="留空使用工具默认模型" hint={opencode ? '格式为 provider/model，如 anthropic/claude-sonnet-5-5' : undefined} />;
}

/** API key：密码框，不显示已保存的原文；用户设置里有 key 时可以勾选“清除” */
function ApiKeyField({ s }: { s: SettingsForm }) {
  const key = s.view!.llm.apiKey;
  const form = s.form!;
  return (
    <div className="field">
      <label>
        <span>API key</span>
        <input type="password" autoComplete="off" data-testid="settings-apiKey" value={form.apiKey} disabled={form.clearApiKey}
          placeholder={apiKeyPlaceholder(key)} onChange={(e) => s.update({ apiKey: e.target.value })} />
      </label>
      {key.source === 'user' && (
        <label className="field-check">
          <input type="checkbox" data-testid="settings-clearApiKey" checked={form.clearApiKey} onChange={(e) => s.update({ clearApiKey: e.target.checked, apiKey: '' })} /> 清除
        </label>
      )}
      <SourceNote name="apiKey" field={key} shadowed={s.view!.llm.shadowed} />
    </div>
  );
}

const UNAVAILABLE_NOTE = 'opencode（本机）暂不可用：还没有确认它的权限限制在当前版本上生效（防止它读写你的文件、执行命令），确认前不能选择。';

function ProviderField({ s }: { s: SettingsForm }) {
  const unavailable = s.view!.unavailableProviders ?? [];
  const replaced = unavailableEffectiveProvider(s.view!);
  return (
    <div className="field">
      <label>
        <span>服务类型</span>
        <select data-testid="settings-provider" value={s.form!.provider} onChange={(e) => s.update({ provider: e.target.value as LlmProvider })}>
          <option value="anthropic">anthropic</option>
          <option value="openai-compatible">openai-compatible</option>
          <option value="claude-code">Claude Code（本机）</option>
          <option value="opencode" disabled={unavailable.includes('opencode')}>opencode（本机）</option>
        </select>
      </label>
      {unavailable.includes('opencode') && <div className="field-note muted" data-testid="settings-provider-unavailable">{UNAVAILABLE_NOTE}</div>}
      {replaced && <div className="field-note warn" data-testid="settings-provider-replaced">当前生效的 {replaced} 暂不可用，这里先改为 anthropic，请重新选择服务类型后保存。</div>}
      <SourceNote name="provider" field={s.view!.llm.provider} shadowed={s.view!.llm.shadowed} />
    </div>
  );
}

/** 从 API 换到本机 CLI 时，已保存的 key 和服务地址不会保留 */
function KeyDropNote({ s }: { s: SettingsForm }) {
  const { llm } = s.view!;
  const hasSaved = llm.apiKey.source === 'user' || llm.baseUrl.source === 'user';
  if (!hasSaved || !isCliProvider(s.form!.provider) || isCliProvider(llm.provider.value)) return null;
  return <div className="warn" data-testid="settings-key-drop">保存后不再保留已保存的 API Key 和服务地址，以后切回需要重新填写。</div>;
}

/** 按 provider 显示的输入项：API 为服务地址、模型、API key；本机 CLI 为命令路径、模型、附加环境变量 */
function ProviderFields({ s }: { s: SettingsForm }) {
  if (isCliProvider(s.form!.provider)) {
    return (
      <>
        <CliFields s={s} />
        <CliModelField s={s} />
        <KeyDropNote s={s} />
      </>
    );
  }
  return (
    <>
      <TextField name="baseUrl" label="服务地址" s={s} />
      <TextField name="model" label="模型" s={s} />
      <ApiKeyField s={s} />
    </>
  );
}

/** 第一部分：模型服务 */
function LlmSection({ s }: { s: SettingsForm }) {
  const problem = s.view!.effective.problem;
  return (
    <section className="settings-section">
      <h4>模型服务</h4>
      <ProviderField s={s} />
      <ProviderFields s={s} />
      {problem && <div className="warn" data-testid="settings-problem">当前配置有问题：{problem}</div>}
      {s.test && <div className={s.test.ok ? 'ok-inline' : 'error-inline'} data-testid="settings-test-result">{testResultText(s.test)}</div>}
      <div className="actions">
        <button type="button" className="small" data-testid="settings-test" disabled={s.busy !== undefined} onClick={() => void s.testConnection()}>
          {s.busy === 'test' ? '正在测试…' : '测试连接'}
        </button>
        {isCliProvider(s.form!.provider) && <span className="muted small-note" data-testid="settings-test-note">会真实调用一次本机 CLI，消耗少量额度</span>}
        <button type="button" className="primary" data-testid="settings-save" disabled={s.busy !== undefined} onClick={() => void s.save()}>保存</button>
      </div>
    </section>
  );
}

/** 第二部分：索引 */
function IndexSection({ s }: { s: SettingsForm }) {
  return (
    <section className="settings-section">
      <h4>索引</h4>
      <label>
        <input type="checkbox" data-testid="settings-autoReindex" checked={s.view!.autoReindex} disabled={s.busy !== undefined}
          onChange={(e) => void s.setAutoReindex(e.target.checked)} /> 检测到代码变化后自动更新索引
      </label>
    </section>
  );
}

/** 设置对话框（顶栏“⚙ 设置”）：模型服务和索引；保存后由 onSaved 刷新页面状态 */
export function SettingsDialog({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const s = useSettingsForm(onSaved);
  return (
    <Modal label="设置" testId="settings-dialog">
      <h3>设置</h3>
      {s.loadError && <div className="error">{s.loadError}</div>}
      {!s.view && !s.loadError && <p className="muted">正在读取设置…</p>}
      {s.view && s.form && <LlmSection s={s} />}
      {s.view && <IndexSection s={s} />}
      {s.message && <div className={s.message.ok ? 'ok-inline' : 'error'} data-testid="settings-message">{s.message.text}</div>}
      <div className="actions">
        {s.view && <span className="muted settings-path">保存在 <code>{s.view.path}</code></span>}
        <button type="button" className="small" data-testid="settings-close" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
