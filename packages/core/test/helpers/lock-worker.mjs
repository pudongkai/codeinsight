// 用法：node lock-worker.mjs <dataDir> <contentKey> <holdMs> <eventsFile> [die]
// 获取快照锁，记录持锁区间；带 die 时持锁后直接退出，不释放
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireSnapshotLock, dataDirLayout } from '../../dist/index.js';

const [dataDir, key, holdMs, events, mode] = process.argv.slice(2);
const h = await acquireSnapshotLock(dataDirLayout(dataDir), key, { pollMs: 5, timeoutMs: 60_000 });
const start = performance.timeOrigin + performance.now();
if (mode === 'die') {
  process.stdout.write('locked\n');
  process.exit(0);
}
await sleep(Number(holdMs));
const end = performance.timeOrigin + performance.now();
appendFileSync(events, `${process.pid} ${start} ${end}\n`);
await h.release();
