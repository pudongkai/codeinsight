// 用法：node overview-worker.mjs <dbPath> <holdMs>
// 开始一个概览任务，把结果（JSON）写到 stdout，持有 holdMs 后不结束任务直接退出，模拟进程中断
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../../dist/index.js';

const [dbPath, holdMs] = process.argv.slice(2);
const store = new Store(dbPath);
const r = store.overviews.begin({ ref: 'working', snapshotKind: 'working', commitSha: 'abc', contentKey: 'k', params: { noLlm: true, sendSource: false } });
process.stdout.write(JSON.stringify({ pid: process.pid, ...r }) + '\n');
await sleep(Number(holdMs));
store.close();
