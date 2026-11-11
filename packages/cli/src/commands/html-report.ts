import { readFile } from 'node:fs/promises';
import { EMBEDDED_REPORT_ELEMENT_ID, ReviewArgsError } from '@codeinsight/core';
import type { ReviewReport } from '@codeinsight/core';

/**
 * 报告 JSON 放进 `<script type="application/json">` 时的转义：`<`、`>`、`&` 和行分隔符都写成 \u 转义，
 * 报告文本里的 `</script>`、`<!--` 不会提前结束脚本块。JSON.parse 读回的内容不变。
 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** 把报告内嵌进单文件 HTML 模板（插在最后一个 `</body>` 前） */
export function renderHtmlReport(report: ReviewReport, template: string): string {
  const at = template.lastIndexOf('</body>');
  if (at < 0) throw new Error('invalid report template: missing </body>');
  const data = `<script type="application/json" id="${EMBEDDED_REPORT_ELEMENT_ID}">${escapeJsonForScript(JSON.stringify(report))}</script>\n`;
  return template.slice(0, at) + data + template.slice(at);
}

export async function readReportTemplate(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw new ReviewArgsError(`HTML report template not found (${(err as Error).message}); build the web UI first: pnpm -r build`);
  }
}
