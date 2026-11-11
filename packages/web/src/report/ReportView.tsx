import type { ReviewReport, SymbolChange } from '@codeinsight/core/report/types';
import { REPORT_SCHEMA_VERSION } from '@codeinsight/core/report/types';
import { useState } from 'react';
import { openInHost } from '../bridge';
import type { ReportActions, SymbolTarget } from './actions';
import { ChangeList } from './ChangeList';
import { DuplicatesPanel } from './DuplicatesPanel';
import { FileList } from './FileList';
import { ImpactPanel } from './ImpactPanel';
import { IntentPanel } from './IntentPanel';
import { ReportHeader } from './ReportHeader';
import { StructureGraph } from './StructureGraph';
import { WarningsPanel } from './WarningsPanel';

interface Props {
  report: ReviewReport;
  /** serve 页面提供；HTML 单文件报告没有 */
  actions?: ReportActions;
  /** 页面级提示，如报告对应的快照已清理 */
  notice?: string;
}

/** 点击函数：有 JS 桥时交给 IDE；否则 serve 页面显示源码，离线报告提示位置 */
function useOpener(actions: ReportActions | undefined) {
  const [offline, setOffline] = useState<string>();
  const open = (t: SymbolTarget) => {
    if (openInHost({ path: t.path, line: t.startLine, removed: t.removed })) return;
    if (actions) actions.showSource(t);
    else setOffline(`离线报告不含源码，位置：${t.path}:${t.startLine}`);
  };
  return { open, offline };
}

/** 审查报告视图：serve 页面和 HTML 单文件报告共用 */
export function ReportView({ report, actions, notice }: Props) {
  const [selected, setSelected] = useState<SymbolChange>();
  const { open, offline } = useOpener(actions);
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    return <div className="error">报告版本 {String(report.schemaVersion)} 不受支持，请升级 codeinsight。</div>;
  }
  return (
    <div className="report" data-testid="report-view">
      <ReportHeader report={report} />
      {notice && <div className="notice" data-testid="report-notice">{notice}</div>}
      {offline && <div className="notice">{offline}</div>}
      <WarningsPanel warnings={report.warnings} />
      <div className="report-grid">
        <ChangeList modules={report.modules} selectedKey={selected?.key} onSelect={setSelected} />
        <ImpactPanel change={selected} onOpen={open} onGraph={actions?.openGraph} />
      </div>
      <StructureGraph report={report} onSelect={setSelected} onOpen={open} />
      <DuplicatesPanel duplicates={report.duplicates} onOpen={open} />
      <IntentPanel report={report} onOpen={open} />
      <FileList files={report.files} />
    </div>
  );
}
