import type { ExternalCategory } from './types.js';

/** 可以出现在分类表里的类别（`other` 是没匹配上时的归类，不进表） */
export const EXTERNAL_CATEGORIES: readonly ExternalCategory[] = [
  'database', 'cache', 'http_client', 'message_queue', 'email', 'payment',
  'storage', 'auth_crypto', 'llm', 'web_framework', 'subprocess',
];

const BUILTIN: Record<Exclude<ExternalCategory, 'other'>, string[]> = {
  database: ['psycopg', 'psycopg_pool', 'psycopg2', 'asyncpg', 'pymysql', 'MySQLdb', 'sqlalchemy', 'sqlmodel', 'sqlite3', 'pymongo', 'motor', 'peewee', 'tortoise', 'django.db'],
  cache: ['redis', 'aioredis', 'pymemcache', 'django.core.cache'],
  http_client: ['requests', 'httpx', 'aiohttp', 'urllib.request', 'http.client', 'urllib3'],
  message_queue: ['celery', 'kombu', 'pika', 'aio_pika', 'kafka', 'aiokafka', 'confluent_kafka', 'nats'],
  // `email` 本身不在表里：只用 email.utils、email.header 解析地址或编码头部不算发邮件
  email: ['smtplib', 'aiosmtplib', 'sendgrid', 'email.mime', 'email.message', 'django.core.mail'],
  payment: ['stripe', 'alipay', 'wechatpayv3', 'paypalrestsdk'],
  storage: ['boto3', 'botocore', 'oss2', 'minio', 'google.cloud.storage'],
  auth_crypto: ['jwt', 'jose', 'passlib', 'bcrypt', 'cryptography'],
  llm: ['openai', 'anthropic'],
  web_framework: ['fastapi', 'starlette', 'flask', 'django'],
  subprocess: ['subprocess'],
};

/** 内置分类表：点分模块名 → 类别 */
export const BUILTIN_EXTERNAL_TABLE: Readonly<Record<string, ExternalCategory>> = Object.fromEntries(
  Object.entries(BUILTIN).flatMap(([category, mods]) => mods.map((m) => [m, category as ExternalCategory])),
);

/** Python 标准库顶层模块名：没匹配上分类表的外部导入里，这些不列出 */
const STDLIB = new Set(`__future__ abc aifc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit audioop
base64 bdb binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys
compileall compression concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime
dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch
fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib
imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap
marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode
operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint
profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter
runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3
sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog
tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback
tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg
winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo`.split(/\s+/));

export function isStdlib(topLevel: string): boolean {
  return STDLIB.has(topLevel) || topLevel.startsWith('_');
}

/** 内置表加配置里的追加或覆盖 */
export function externalTable(overrides: Readonly<Record<string, ExternalCategory>> = {}): Map<string, ExternalCategory> {
  return new Map(Object.entries({ ...BUILTIN_EXTERNAL_TABLE, ...overrides }));
}

/** 按点分段的最长前缀匹配：`django.db.models` 匹配 `django.db` 而不是 `django`，`psycopg_pool` 不会匹配 `psycopg` */
export function matchExternal(table: ReadonlyMap<string, ExternalCategory>, dotted: string): { lib: string; category: ExternalCategory } | undefined {
  const parts = dotted.split('.');
  for (let n = parts.length; n > 0; n--) {
    const prefix = parts.slice(0, n).join('.');
    const category = table.get(prefix);
    if (category) return { lib: prefix, category };
  }
  return undefined;
}

/**
 * 一条外部导入的分类：模块名和候选名里取最长的匹配；都没匹配上时，标准库返回 undefined（不列出），
 * 其余归 `other`，库名取第一段。
 */
export function classifyExternal(
  table: ReadonlyMap<string, ExternalCategory>, module: string, candidates: readonly string[] = [],
): { lib: string; category: ExternalCategory } | undefined {
  let best: { lib: string; category: ExternalCategory } | undefined;
  for (const name of [module, ...candidates]) {
    const hit = matchExternal(table, name);
    if (hit && (!best || hit.lib.split('.').length > best.lib.split('.').length)) best = hit;
  }
  if (best) return best;
  const top = module.split('.')[0]!;
  return isStdlib(top) ? undefined : { lib: top, category: 'other' };
}
