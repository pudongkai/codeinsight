// 按 `codeinsight serve --open` 运行，打开浏览器的动作换成在 stdout 再输出一行 {"opened": url}，由测试代替浏览器去打开
import { runServeCommand } from '../../../cli/dist/commands/serve.js';

await runServeCommand([...process.argv.slice(2), '--open'], {
  openUrl: (url) => process.stdout.write(JSON.stringify({ opened: url }) + '\n'),
});
