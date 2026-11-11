import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { readEmbeddedReport } from './report/embedded';
import { ReportView } from './report/ReportView';
import './styles.css';

/** 单文件 HTML 报告：读取内嵌的报告 JSON，用与 serve 页面相同的报告视图渲染，不发任何网络请求 */
const { report, error } = readEmbeddedReport(document);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="standalone">{report ? <ReportView report={report} /> : <div className="error">{error}</div>}</main>
  </StrictMode>,
);
