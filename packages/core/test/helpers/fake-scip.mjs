// 假的 scip-python：写一半临时输出后一直挂着，用于测试退出时结束子进程、清理临时文件。
// 环境变量 FAKE_SCIP_PID_FILE 指定写入自身 pid 的文件。
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('--output') + 1], 'partial');
if (process.env.FAKE_SCIP_PID_FILE) writeFileSync(process.env.FAKE_SCIP_PID_FILE, String(process.pid));
setInterval(() => undefined, 1000);
