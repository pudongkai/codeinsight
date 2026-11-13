import { DEFAULT_CLI_COMMAND, isCliProvider } from '@codeinsight/core/settings/types';
import { sourceText } from './labels';
import type { EnvRow, SettingsForm } from './useSettingsForm';

/**
 * 命令路径输入框的提示：当前生效的就是这个 provider 时给出实际找到的路径；否则环境变量指定了命令时说明会用它，
 * 都没有时说明会自动查找
 */
export function commandPlaceholder(s: Pick<SettingsForm, 'form' | 'view'>): string {
  const provider = s.form!.provider;
  const cmd = s.view!.llm.command;
  if (cmd && s.view!.llm.provider.value === provider) return cmd.resolved ?? '未找到，请填写可执行文件路径';
  const fromEnv = s.view!.llm.commandEnv;
  if (fromEnv) return `留空则使用环境变量 CODEINSIGHT_LLM_COMMAND 指定的 ${fromEnv}`;
  return `留空则自动查找 ${isCliProvider(provider) ? DEFAULT_CLI_COMMAND[provider] : ''}`;
}

function CommandField({ s }: { s: SettingsForm }) {
  const cmd = s.view!.llm.command;
  return (
    <div className="field">
      <label>
        <span>命令路径</span>
        <input data-testid="settings-command" value={s.form!.command} placeholder={commandPlaceholder(s)} onChange={(e) => s.update({ command: e.target.value })} />
      </label>
      {cmd && cmd.source !== 'none' && <div className="field-note muted" data-testid="settings-command-source">来源：{sourceText(cmd)}</div>}
    </div>
  );
}

function EnvRowEdit({ row, onChange, onRemove }: { row: EnvRow; onChange(patch: Partial<EnvRow>): void; onRemove(): void }) {
  return (
    <div className="field-note" data-testid="settings-env-row">
      <input data-testid="settings-env-name" aria-label="变量名" placeholder="名字" value={row.name} readOnly={row.hidden} onChange={(e) => onChange({ name: e.target.value })} />
      <span>=</span>
      <input data-testid="settings-env-value" aria-label="值" value={row.value}
        placeholder={row.hidden ? (row.shown ? `${row.shown}（已去掉账号密码等），留空不修改` : '已设置（值不显示），留空不修改') : '值'} onChange={(e) => onChange({ value: e.target.value })} />
      <button type="button" className="small" data-testid="settings-env-remove" onClick={onRemove}>删除</button>
    </div>
  );
}

/** 附加环境变量：启动本机 CLI 时加上（如代理地址）；看不到原值的项留空表示不修改 */
function ExtraEnvField({ s }: { s: SettingsForm }) {
  const rows = s.form!.envRows;
  const set = (next: EnvRow[]) => s.update({ envRows: next });
  return (
    <div className="field" data-testid="settings-extraEnv">
      <label>
        <span>附加环境变量</span>
        <span className="muted small-note">启动本机 CLI 时附加，如 https_proxy；子进程拿不到 shell 里的 alias 和临时设置</span>
      </label>
      {rows.map((row, i) => (
        <EnvRowEdit key={i} row={row} onChange={(patch) => set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))} onRemove={() => set(rows.filter((_, j) => j !== i))} />
      ))}
      <div className="field-note">
        <button type="button" className="small" data-testid="settings-env-add" onClick={() => set([...rows, { name: '', value: '', hidden: false }])}>添加一项</button>
      </div>
    </div>
  );
}

/** 本机 CLI 的设置项：命令路径、附加环境变量（模型输入框和 API 共用，在对话框里） */
export function CliFields({ s }: { s: SettingsForm }) {
  return (
    <>
      <CommandField s={s} />
      <ExtraEnvField s={s} />
    </>
  );
}
