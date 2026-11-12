import { useState } from 'react';

/** 只存这一个布尔值 */
const STORAGE_KEY = 'codeinsight.graph.showModels';

/** localStorage 不可用（如某些离线打开的 HTML 报告）时按默认值"显示"处理 */
function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeStored(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // 存不了就只在本次页面里生效
  }
}

/** 图上是否显示模型类节点，默认显示，选择记在 localStorage 里 */
export function useShowModels(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(readStored);
  const set = (v: boolean) => {
    setValue(v);
    writeStored(v);
  };
  return [value, set];
}

/** "显示模型"开关，邻居图和结构图共用 */
export function ShowModelsToggle({ value, onChange }: { value: boolean; onChange(value: boolean): void }) {
  return (
    <label className="graph-toggle">
      <input type="checkbox" data-testid="toggle-models" checked={value} onChange={(e) => onChange(e.target.checked)} /> 显示模型
    </label>
  );
}
