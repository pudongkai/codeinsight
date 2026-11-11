import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** 常量时间比较：先取摘要使两边等长，比较耗时与内容和长度都无关 */
export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined || given === '') return false;
  return timingSafeEqual(digest(expected), digest(given));
}

/** cookie 名带端口：同时开多个项目的 serve 时（JCEF 在整个 IDE 内共用 cookie）不会互相覆盖 */
export function cookieName(port: number): string {
  return `ci_${port}`;
}

export function sessionCookie(port: number, token: string): string {
  return `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export type AuthResult = { ok: true; via: 'cookie' | 'bearer' } | { ok: false; reason: 'missing' | 'invalid' };

/** 接受 `ci_<端口>` cookie 或 `Authorization: Bearer <token>` 头，任一匹配即通过 */
export function authenticate(req: IncomingMessage, token: string, port: number): AuthResult {
  const cookie = readCookie(req.headers.cookie, cookieName(port));
  if (tokenMatches(token, cookie)) return { ok: true, via: 'cookie' };
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined;
  if (tokenMatches(token, bearer)) return { ok: true, via: 'bearer' };
  return { ok: false, reason: cookie === undefined && bearer === undefined ? 'missing' : 'invalid' };
}

/**
 * 防 DNS rebinding：Host 必须是 127.0.0.1 或 localhost 加本服务端口；
 * 带 Origin 时（浏览器跨源请求）也必须是这两个地址之一。
 */
export function hostAllowed(req: IncomingMessage, port: number): boolean {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = req.headers.host?.toLowerCase();
  if (!host || !allowed.has(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && allowed.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}
