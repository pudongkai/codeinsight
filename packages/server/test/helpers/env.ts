import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDataDir, loadConfig, Store } from '@codeinsight/core';
import type { Resolver } from '@codeinsight/core';
import type { ServerWorkspace } from '../../src/index.js';

export const FIXTURE = path.resolve(import.meta.dirname, '..', '..', '..', 'core', 'test', 'fixtures', 'py-basic');

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

/** 搜索排序用：完全相同 / 前缀 / 子串，正式代码和测试代码各有 */
const EXTRA_FILES = {
  'pkg/finder.py': 'def find(x):\n    return x\n\n\ndef find_all(xs):\n    return [find(x) for x in xs]\n\n\ndef refind():\n    return find(1)\n',
  'tests/test_finder.py': 'from pkg.finder import find\n\n\ndef find_helper():\n    return find(2)\n\n\ndef test_find():\n    assert find(3) == 3\n',
  // 与 pkg/service.py 的 register 同名、签名形状相同：同名重复候选
  'pkg/extra.py': 'def register(cb=None):\n    return cb\n',
  // 模型类（含跨文件继承）、方法和调用它们的 HTTP 接口：检查 API 里的 modelKind、entry 字段
  'pkg/schemas.py': 'from pydantic import BaseModel\n\n\nclass Item(BaseModel):\n    name: str\n',
  'pkg/views_api.py':
    'from fastapi import APIRouter\nfrom pkg.schemas import Item\n\nrouter = APIRouter()\n\n\nclass ItemOut(Item):\n    id: int\n\n    def label(self):\n        return self.name\n\n\n' +
    '@router.get("/labels/{item_id}")\ndef read_label(item_id: int):\n    return ItemOut(name="x", id=item_id).label()\n',
};

/**
 * fixtures 仓库：py-basic 加上搜索和重复实现用的文件作为第一个提交，
 * 第二个提交在 pkg/repo.py 里新增调用 f 的 h
 */
export function fixtureRepo(): string {
  const repo = tempDir('ci-server-repo-');
  cpSync(FIXTURE, repo, { recursive: true });
  writeFiles(repo, EXTRA_FILES);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  writeFiles(repo, { 'pkg/more.py': 'from pkg.repo import f\n\n\ndef h(n):\n    total = 0\n    for i in range(n):\n        total += f(i)\n    return total\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Add h');
  return repo;
}

/** 测试用的 workspace：不读本机环境变量（不会拿到 LLM 配置和 API key） */
export async function openWorkspace(repo: string, dataDir: string, resolver?: Resolver): Promise<ServerWorkspace> {
  const config = await loadConfig(repo, { dataDir, env: {} });
  const layout = await initDataDir(config.dataDir);
  return { repo, config, layout, store: new Store(layout.dbPath), resolver };
}

export interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

/** 原样发送路径（不做规范化），可以自定义 Host 等请求头 */
export function request(port: number, rawPath: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      { host: '127.0.0.1', port, path: rawPath, method: opts.method ?? 'GET', headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T>() => JSON.parse(body) as T });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

export async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
