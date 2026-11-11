import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Web UI 构建产物在 cli 发布目录里的位置（dist → 包根目录/web），构建时由 scripts/copy-web.mjs 复制进来 */
export const DEFAULT_STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** 单文件 HTML 报告模板（web 用同一套报告视图构建，JS 和 CSS 已内联） */
export const DEFAULT_REPORT_TEMPLATE = path.join(DEFAULT_STATIC_DIR, 'report.html');
