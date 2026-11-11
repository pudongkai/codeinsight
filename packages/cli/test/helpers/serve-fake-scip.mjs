// 按 `codeinsight serve` 的方式运行（含信号处理），scip-python 换成第一个参数指定的脚本
import { ScipPythonResolver } from '@codeinsight/core';
import { runServeCommand } from '../../dist/commands/serve.js';

const [bin, ...argv] = process.argv.slice(2);
// 测试退出过程中再收到 SIGTERM：stdin 读到 EOF 时给自己发 SIGTERM，信号在 serve 开始退出后才被处理
if (process.env.SERVE_HELPER_SIGTERM_ON_STDIN_END === '1') process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'));
await runServeCommand(argv, { resolver: new ScipPythonResolver({ bin }), openUrl: () => undefined });
