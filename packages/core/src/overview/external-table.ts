import { rustCrateName } from '../extract/rust-cargo.js';
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

// ---------- Go ----------

/** Go 第三方库分类表：import 路径前缀（不含 `/vN` 主版本段）→ 类别 */
const GO_BUILTIN: Record<Exclude<ExternalCategory, 'other' | 'subprocess'>, string[]> = {
  database: [
    'gorm.io/gorm', 'gorm.io/driver', 'github.com/jmoiron/sqlx', 'github.com/go-sql-driver/mysql', 'github.com/lib/pq',
    'github.com/jackc/pgx', 'go.mongodb.org/mongo-driver', 'github.com/mattn/go-sqlite3', 'modernc.org/sqlite', 'entgo.io/ent',
    'github.com/uptrace/bun', 'xorm.io/xorm', 'github.com/Masterminds/squirrel', 'github.com/elastic/go-elasticsearch',
    'github.com/olivere/elastic', 'github.com/gocql/gocql', 'github.com/ClickHouse/clickhouse-go', 'go.etcd.io/bbolt',
    'github.com/dgraph-io/badger', 'github.com/denisenkomssqldb/go-mssqldb', 'github.com/microsoft/go-mssqldb',
  ],
  cache: [
    'github.com/redis/go-redis', 'github.com/go-redis/redis', 'github.com/gomodule/redigo', 'github.com/bradfitz/gomemcache',
    'github.com/patrickmn/go-cache', 'github.com/allegro/bigcache', 'github.com/coocood/freecache', 'github.com/dgraph-io/ristretto',
  ],
  http_client: ['github.com/go-resty/resty', 'github.com/imroc/req', 'github.com/hashicorp/go-retryablehttp', 'github.com/parnurzeal/gorequest'],
  message_queue: [
    'github.com/segmentio/kafka-go', 'github.com/IBM/sarama', 'github.com/Shopify/sarama', 'github.com/confluentinc/confluent-kafka-go',
    'github.com/nats-io/nats.go', 'github.com/rabbitmq/amqp091-go', 'github.com/streadway/amqp', 'github.com/apache/pulsar-client-go',
    'github.com/apache/rocketmq-client-go', 'github.com/nsqio/go-nsq', 'github.com/hibiken/asynq', 'cloud.google.com/go/pubsub',
  ],
  email: ['gopkg.in/gomail.v2', 'github.com/go-gomail/gomail', 'github.com/jordan-wright/email', 'github.com/wneessen/go-mail', 'github.com/sendgrid/sendgrid-go'],
  payment: ['github.com/stripe/stripe-go', 'github.com/smartwalle/alipay', 'github.com/wechatpay-apiv3/wechatpay-go', 'github.com/go-pay/gopay'],
  storage: [
    'github.com/aws/aws-sdk-go', 'github.com/aws/aws-sdk-go-v2', 'cloud.google.com/go/storage', 'github.com/Azure/azure-sdk-for-go',
    'github.com/minio/minio-go', 'github.com/aliyun/aliyun-oss-go-sdk', 'github.com/tencentyun/cos-go-sdk-v5', 'github.com/qiniu/go-sdk',
  ],
  auth_crypto: [
    'github.com/golang-jwt/jwt', 'github.com/dgrijalva/jwt-go', 'github.com/lestrrat-go/jwx', 'golang.org/x/crypto', 'golang.org/x/oauth2',
    'github.com/coreos/go-oidc', 'github.com/casbin/casbin',
  ],
  llm: ['github.com/sashabaranov/go-openai', 'github.com/openai/openai-go', 'github.com/anthropics/anthropic-sdk-go', 'github.com/tmc/langchaingo'],
  // RPC 框架也算对外提供接口的服务框架
  web_framework: [
    'github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/go-chi/chi', 'github.com/gofiber/fiber', 'github.com/gorilla/mux',
    'github.com/julienschmidt/httprouter', 'github.com/valyala/fasthttp', 'github.com/beego/beego', 'github.com/astaxie/beego',
    'github.com/kataras/iris', 'github.com/emicklei/go-restful', 'google.golang.org/grpc', 'github.com/grpc-ecosystem/grpc-gateway',
    'connectrpc.com/connect', 'github.com/bufbuild/connect-go', 'github.com/go-kratos/kratos', 'github.com/zeromicro/go-zero',
    'github.com/go-kit/kit', 'go-micro.dev', 'github.com/cloudwego/kitex', 'github.com/cloudwego/hertz',
  ],
};

/** 内置的 Go 分类表 */
export const GO_EXTERNAL_TABLE: ReadonlyMap<string, ExternalCategory> = new Map(
  Object.entries(GO_BUILTIN).flatMap(([category, paths]) => paths.map((p): [string, ExternalCategory] => [p, category as ExternalCategory])),
);

/** 托管站点下的仓库路径固定为三段：`github.com/<owner>/<repo>` */
const THREE_SEGMENT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'gitee.com', 'golang.org']);

/** 去掉 `/vN` 主版本段：`github.com/jackc/pgx/v5/pgxpool` → `github.com/jackc/pgx/pgxpool` */
function withoutMajorVersion(importPath: string): string[] {
  return importPath.split('/').filter((seg, i) => i === 0 || !/^v\d+$/.test(seg));
}

/** 没在分类表里的第三方 import 的库名：按常见托管站点的路径规则推测 module 根路径 */
function goLibName(parts: readonly string[]): string {
  const n = THREE_SEGMENT_HOSTS.has(parts[0]!) || (parts[0] === 'gopkg.in' && !parts[1]?.includes('.')) ? 3 : 2;
  return parts.slice(0, n).join('/');
}

/** Go 标准库：路径第一段不含 `.`（含 cgo 的 `C`） */
export function isGoStdlib(importPath: string): boolean {
  return !importPath.split('/')[0]!.includes('.');
}

/** 是项目里某个 go.mod 的 module 或其子包 */
export function isGoProjectImport(importPath: string, modulePaths: Iterable<string>): boolean {
  for (const m of modulePaths) if (importPath === m || importPath.startsWith(`${m}/`)) return true;
  return false;
}

/**
 * 一条 Go import 的分类：标准库和项目内包返回 undefined；其余按路径段的最长前缀匹配分类表（忽略 `/vN`），
 * 都没匹配上时归 `other`，库名取推测的 module 根路径
 */
export function classifyGoImport(
  importPath: string, modulePaths: Iterable<string>, table: ReadonlyMap<string, ExternalCategory> = GO_EXTERNAL_TABLE,
): { lib: string; category: ExternalCategory } | undefined {
  if (isGoStdlib(importPath) || isGoProjectImport(importPath, modulePaths)) return undefined;
  const parts = withoutMajorVersion(importPath);
  for (let n = parts.length; n > 0; n--) {
    const prefix = parts.slice(0, n).join('/');
    const category = table.get(prefix);
    if (category) return { lib: prefix, category };
  }
  return { lib: goLibName(parts), category: 'other' };
}

const RUST_BUILTIN: Record<Exclude<ExternalCategory, 'other' | 'subprocess'>, string[]> = {
  database: ['sqlx', 'diesel', 'sea-orm', 'rusqlite', 'postgres', 'tokio-postgres', 'mongodb', 'mysql'],
  cache: ['redis', 'deadpool-redis', 'moka'],
  http_client: ['reqwest', 'ureq', 'isahc', 'surf'],
  message_queue: ['lapin', 'rdkafka', 'async-nats', 'pulsar'],
  email: ['lettre'],
  payment: ['async-stripe'],
  storage: ['aws-sdk-s3', 'object_store', 'opendal', 'rust-s3'],
  auth_crypto: ['jsonwebtoken', 'ring', 'argon2', 'bcrypt', 'openssl', 'rustls'],
  llm: ['async-openai'],
  web_framework: ['axum', 'actix-web', 'rocket', 'warp', 'poem', 'salvo', 'tonic', 'hyper'],
};

/** 内置的 Rust 分类表：crate 名（`-` 换成 `_`）→ 类别 */
export const RUST_EXTERNAL_TABLE: ReadonlyMap<string, ExternalCategory> = new Map(
  Object.entries(RUST_BUILTIN).flatMap(([category, crates]) => crates.map((c): [string, ExternalCategory] => [rustCrateName(c), category as ExternalCategory])),
);

/** 分类表里代码中的 crate 名和依赖名转下划线后不同的包：依赖名 → 代码里写的 crate 名 */
const RUST_LIB_ALIASES: ReadonlyMap<string, string> = new Map([['async-stripe', 'stripe'], ['rust-s3', 's3']]);

/** 依赖在代码里可能出现的 crate 名：依赖名转下划线，以及已知的库名 */
export function rustDepRoots(dep: string): string[] {
  const alias = RUST_LIB_ALIASES.get(dep);
  return alias ? [rustCrateName(dep), alias] : [rustCrateName(dep)];
}

/**
 * Rust 路径第一段的分类：deps 为代码里的 crate 名 → Cargo.toml 里的依赖名（见 rustDepRoots）；在依赖里的为第三方库
 * （库名取依赖名），按分类表归类，没匹配上为 `other`；不在依赖里的（标准库、crate/self/super、工作区内的 crate、
 * 子模块名、局部变量）返回 undefined
 */
export function classifyRustRoot(
  root: string, deps: ReadonlyMap<string, string>, table: ReadonlyMap<string, ExternalCategory> = RUST_EXTERNAL_TABLE,
): { lib: string; category: ExternalCategory } | undefined {
  const lib = deps.get(root);
  if (lib === undefined) return undefined;
  return { lib, category: table.get(rustCrateName(lib)) ?? 'other' };
}
