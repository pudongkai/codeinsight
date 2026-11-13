// 按 `codeinsight mcp --ask-tools` 的参数启动问答工具 MCP 服务（stdio）；配置不读本机环境变量。
// 快照不存在或没建好时 stderr 写一行原因并以 1 退出。
import { parseArgs } from 'node:util';
import { initDataDir, loadConfig, Store } from '@codeinsight/core';
import { askToolContext, AskToolsSnapshotError, runAskToolsMcpStdio } from '../../dist/index.js';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' }, 'data-dir': { type: 'string' }, snapshot: { type: 'string' },
    'no-source': { type: 'boolean' }, 'max-tool-chars': { type: 'string' },
  },
  strict: true,
});
const config = await loadConfig(values.repo, { dataDir: values['data-dir'], env: {}, userSettings: null });
const layout = await initDataDir(config.dataDir);
const store = new Store(layout.dbPath);
try {
  const ctx = askToolContext({ repo: values.repo, config, layout, store }, Number(values.snapshot), values['no-source'] !== true);
  await runAskToolsMcpStdio(ctx, { maxToolChars: Number(values['max-tool-chars'] ?? config.ask.maxToolChars) });
} catch (err) {
  if (!(err instanceof AskToolsSnapshotError)) throw err;
  process.stderr.write(`error: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
