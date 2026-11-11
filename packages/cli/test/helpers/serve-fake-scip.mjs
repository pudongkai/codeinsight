// 按 `codeinsight serve` 的方式运行（含信号处理），scip-python 换成第一个参数指定的脚本
import { ScipPythonResolver } from '@codeinsight/core';
import { runServeCommand } from '../../dist/commands/serve.js';

const [bin, ...argv] = process.argv.slice(2);
await runServeCommand(argv, { resolver: new ScipPythonResolver({ bin }), openUrl: () => undefined });
