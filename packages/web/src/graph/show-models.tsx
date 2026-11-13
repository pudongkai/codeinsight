import { useStoredFlag } from '../stored-flag';

/** 只存这一个布尔值 */
const STORAGE_KEY = 'codeinsight.graph.showModels';

/** 图上是否显示模型类节点，默认显示，选择记在 localStorage 里 */
export function useShowModels(): [boolean, (value: boolean) => void] {
  return useStoredFlag(STORAGE_KEY, true);
}

/** "显示模型"开关，邻居图和结构图共用 */
export function ShowModelsToggle({ value, onChange }: { value: boolean; onChange(value: boolean): void }) {
  return (
    <label className="graph-toggle">
      <input type="checkbox" data-testid="toggle-models" checked={value} onChange={(e) => onChange(e.target.checked)} /> 显示模型
    </label>
  );
}
