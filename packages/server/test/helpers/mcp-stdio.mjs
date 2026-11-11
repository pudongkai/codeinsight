// 在子进程里按 `codeinsight mcp` 的方式启动 stdio MCP 服务；配置不读本机环境变量。
// 第三个参数可选：scip-python 入口脚本（测试用假脚本）
import { initDataDir, loadConfig, ScipPythonResolver, Store } from '@codeinsight/core';
import { runMcpStdio } from '../../dist/index.js';

const [repo, dataDir, bin] = process.argv.slice(2);
const config = await loadConfig(repo, { dataDir, env: {} });
const layout = await initDataDir(config.dataDir);
const store = new Store(layout.dbPath);
const resolver = bin ? new ScipPythonResolver({ bin }) : undefined;
await runMcpStdio({ workspace: { repo, config, layout, store, resolver } });
store.close();
