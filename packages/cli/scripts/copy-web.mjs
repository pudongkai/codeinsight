// 把 @codeinsight/web 的构建产物复制到 cli 包的 web/ 目录（serve 托管的页面和 HTML 报告模板）
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const webRoot = path.dirname(require.resolve('@codeinsight/web/package.json'));
const from = path.join(webRoot, 'dist');
const to = path.resolve(import.meta.dirname, '..', 'web');
for (const f of ['index.html', 'report.html']) {
  if (!existsSync(path.join(from, f))) {
    console.error(`copy-web: ${path.join(from, f)} is missing; build @codeinsight/web first`);
    process.exit(1);
  }
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.error(`copy-web: ${from} -> ${to}`);
