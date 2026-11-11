import { EMBEDDED_REPORT_ELEMENT_ID, type ReviewReport } from '@codeinsight/core/report/types';

/** 读取内嵌的报告；没有或不是合法 JSON 时返回错误说明 */
export function readEmbeddedReport(doc: Document): { report?: ReviewReport; error?: string } {
  const el = doc.getElementById(EMBEDDED_REPORT_ELEMENT_ID);
  if (!el?.textContent?.trim()) return { error: '报告数据缺失：这是报告模板，请用 codeinsight review --format html 生成报告。' };
  try {
    return { report: JSON.parse(el.textContent) as ReviewReport };
  } catch (err) {
    return { error: `报告数据无法解析：${(err as Error).message}` };
  }
}
