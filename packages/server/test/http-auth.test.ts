import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLogSink } from '@codeinsight/core';
import { startHttpServer, type RunningHttpServer } from '../src/index.js';
import { git, openWorkspace, request, tempDir, writeFiles } from './helpers/env.js';
import type { ServerWorkspace } from '../src/index.js';

const logLines: string[] = [];
let restoreSink: ((line: string) => void) | undefined;
const prevLevel = process.env.CODEINSIGHT_LOG;

let ws: ServerWorkspace;
let server: RunningHttpServer;
let staticDir: string;
let repoDir: string;

beforeAll(async () => {
  process.env.CODEINSIGHT_LOG = 'info';
  restoreSink = setLogSink((line) => logLines.push(line));
  const repo = (repoDir = tempDir('ci-auth-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  writeFiles(repo, { 'a.py': 'def a():\n    return 1\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  staticDir = tempDir('ci-static-');
  writeFileSync(path.join(staticDir, 'index.html'), '<html>web ui</html>');
  mkdirSync(path.join(staticDir, 'assets'));
  writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  symlinkSync('loop.js', path.join(staticDir, 'loop.js'));
  ws = await openWorkspace(repo, tempDir('ci-auth-data-'));
  server = await startHttpServer({ workspace: ws, staticDir, indexOnStart: false });
});

afterAll(async () => {
  await server?.close();
  if (restoreSink) setLogSink(restoreSink);
  if (prevLevel === undefined) delete process.env.CODEINSIGHT_LOG;
  else process.env.CODEINSIGHT_LOG = prevLevel;
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('http auth', () => {
  it('listens on 127.0.0.1 with a random port and prints a url carrying the token', () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.token.length).toBeGreaterThanOrEqual(40);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);
  });

  it('returns 401 without a token or with a wrong one', async () => {
    expect((await request(server.port, '/api/status')).status).toBe(401);
    expect((await request(server.port, '/')).status).toBe(401);
    expect((await request(server.port, '/assets/app.js')).status).toBe(401);
    expect((await request(server.port, '/api/status', { headers: bearer('wrong') })).status).toBe(401);
    expect((await request(server.port, '/api/status', { headers: { Cookie: `ci_${server.port}=wrong` } })).status).toBe(401);
    expect((await request(server.port, '/?token=wrong')).status).toBe(401);
    // ?token= 只在首页换 cookie，不能直接访问 API
    expect((await request(server.port, `/api/status?token=${server.token}`)).status).toBe(401);
  });

  it('requires the token on the overview and chat routes', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/overview'], ['GET', '/api/overview?id=1'], ['GET', '/api/overview/estimate'], ['POST', '/api/overview'],
      ['GET', '/api/overview/jobs/1'], ['GET', '/api/chat/sessions'], ['POST', '/api/chat/sessions'], ['GET', '/api/chat/sessions/1'],
      ['DELETE', '/api/chat/sessions/1'], ['POST', '/api/chat/sessions/1/messages'],
    ];
    for (const [method, p] of routes) {
      expect((await request(server.port, p, { method, body: method === 'GET' || method === 'DELETE' ? undefined : { question: 'q' } })).status, `${method} ${p}`).toBe(401);
      expect((await request(server.port, p, { method, headers: { ...bearer(server.token), Origin: 'http://evil.example' } })).status, `${method} ${p}`).toBe(403);
    }
  });

  it('accepts the bearer token', async () => {
    const res = await request(server.port, '/api/status', { headers: bearer(server.token) });
    expect(res.status).toBe(200);
    expect(res.json().repo).toBe(ws.repo);
  });

  it('exchanges ?token= on / for an HttpOnly SameSite=Strict cookie, then serves API and static files by cookie', async () => {
    const login = await request(server.port, `/?token=${server.token}`);
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/');
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain(`ci_${server.port}=${server.token}`);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    const cookie = { Cookie: `other=1; ci_${server.port}=${server.token}` };
    expect((await request(server.port, '/api/status', { headers: cookie })).status).toBe(200);
    const index = await request(server.port, '/', { headers: cookie });
    expect(index.status).toBe(200);
    expect(index.body).toContain('web ui');
    const asset = await request(server.port, '/assets/app.js', { headers: cookie });
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    // 前端路由回落到 index.html
    expect((await request(server.port, '/browse/symbol', { headers: cookie })).body).toContain('web ui');
    expect((await request(server.port, '/assets/missing.js', { headers: cookie })).status).toBe(404);
  });

  it('rejects foreign Host and Origin headers (DNS rebinding)', async () => {
    const h = bearer(server.token);
    expect((await request(server.port, '/api/status', { headers: { ...h, Host: `evil.example:${server.port}` } })).status).toBe(403);
    expect((await request(server.port, '/api/status', { headers: { ...h, Host: `127.0.0.1:${server.port + 1}` } })).status).toBe(403);
    expect((await request(server.port, '/api/status', { headers: { ...h, Origin: 'http://evil.example' } })).status).toBe(403);
    expect((await request(server.port, '/api/status', { headers: { ...h, Host: `localhost:${server.port}` } })).status).toBe(200);
  });

  it('does not serve files outside the static directory', async () => {
    const h = bearer(server.token);
    for (const p of ['/..%2f..%2f..%2fetc%2fpasswd', '/assets/..%2f..%2fsecret']) {
      const res = await request(server.port, p, { headers: h });
      expect(res.status, p).toBe(403);
    }
    // `%2e%2e` 段由 URL 解析规范化掉，落在静态目录内，按前端路由回落到 index.html
    const dots = await request(server.port, '/%2e%2e/%2e%2e/etc/passwd', { headers: h });
    expect(dots.body).toContain('web ui');
  });

  it('answers 404 for over-long names and symlink loops', async () => {
    const h = bearer(server.token);
    expect((await request(server.port, `/${'a'.repeat(300)}.js`, { headers: h })).status).toBe(404);
    expect((await request(server.port, '/loop.js', { headers: h })).status).toBe(404);
  });

  it('never writes the token to the log', () => {
    expect(logLines.some((l) => l.includes('http_auth_failed'))).toBe(true);
    expect(logLines.some((l) => l.includes('http_request'))).toBe(true);
    expect(logLines.filter((l) => l.includes(server.token))).toEqual([]);
  });
});

describe('static placeholder', () => {
  it('serves a placeholder page when the web UI has not been built', async () => {
    // 关闭服务时会关闭它的 Store，另开一个工作区
    const own = await openWorkspace(repoDir, tempDir('ci-auth-data-'));
    const other = await startHttpServer({ workspace: own, staticDir: path.join(staticDir, 'missing'), indexOnStart: false });
    try {
      const res = await request(other.port, '/', { headers: bearer(other.token) });
      expect(res.status).toBe(200);
      expect(res.body).toContain('web UI has not been built');
    } finally {
      await other.close();
    }
  });
});

describe('internal errors', () => {
  it('returns only the error code, details go to the log', async () => {
    const repo = tempDir('ci-err-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    const broken = await openWorkspace(repo, tempDir('ci-err-data-'));
    const other = await startHttpServer({ workspace: broken, indexOnStart: false });
    try {
      broken.store.close();
      const res = await request(other.port, '/api/status', { headers: bearer(other.token) });
      expect(res.status).toBe(500);
      expect(res.body).toBe('{"error":"internal_error"}');
      expect(logLines.some((l) => l.includes('http_request') && l.includes('status=500') && l.includes('error='))).toBe(true);
    } finally {
      await other.close();
    }
  });
});
