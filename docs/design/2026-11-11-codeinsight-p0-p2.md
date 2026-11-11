# CodeInsight P0–P2 技术方案：Python 结构化审查、CLI/MCP 与 JetBrains 插件

开发状态: BLOCKED
方案评审: 通过（2026-11-11）
需求来源: 2026-11-11 头脑风暴对话，以及在 clauve、bluewhale 上的验证结论
作者: steve@data-coding.com　　日期: 2026-11-11

## 1. 背景与目标

AI 写代码的速度远超人审代码的速度。在纯 AI 写的项目 clauve 上统计：10% 的提交改动 19 个以上文件，最大一次 98 个文件、7329 行。逐行读 diff 已经审不过来，而且容易漏掉这几类问题：

- **提交说明和实际改动不一致**：抽查 4 个大提交，3 个漏写了整块功能（如 fc4c752 说明里没提新增的"组织/团队/成员管理"，16 个函数 + 9 个模板）。
- **重复实现**：同一功能被重新写一遍，并开始各自演变（如 `insert_lease` 两份，其中一份已没人调用，参数类型也没跟上）。
- **改了调用方很多的函数却没意识到影响面**。

CodeInsight 是一个开源的本地工具，把审查从"逐行看 diff"变成"看结构上改了什么"。本方案覆盖 P0–P2，做完后要达到：

1. `codeinsight review` 能对一个 Python 项目的提交区间或未提交改动，输出按模块分组的函数级改动清单，每个改动函数附带正式代码和测试代码的调用方数量。
2. 在 clauve 的提交 80cf8e1 上，`insert_audit_log`（lease 模块那份）的调用方是 7 个（全部是正式代码）、`select_release_by_version` 是 30 个（正式代码 14、测试代码 16），与按 `git grep` 逐个核对调用点的结果一致。正式代码到测试代码的调用边为 0。
3. 能找出新增函数与已有函数的重复实现候选；配置了 LLM 时，能对照任务描述指出"说明里没提到的改动"。
4. AI agent 能通过 MCP 调用同样的审查能力；人能在 PyCharm / IDEA 的工具窗口里看到同一份结果，点击函数跳到源码。
5. 不装 IDE 也能用：`codeinsight serve --open` 在浏览器里打开同一个 Web UI，可以审查改动，也可以搜索函数、查看它的调用方和被调用方、浏览入口列表和源码。
6. 数据模型按多语言设计，后续加 Java、TS 时不改存储结构和 diff 逻辑。

## 2. 范围

**本次要做：**
- pnpm monorepo 骨架；core 数据模型与 SQLite 存储，按多语言预留字段
- Python 提取层（tree-sitter）：函数、类、方法、签名、函数体 hash、装饰器、入口识别（FastAPI / Flask / Django / Celery / click）
- Python 解析层：调用 scip-python，把 SCIP 转换成调用边
- 结构化 diff：函数级新增、删除、修改、签名变化、搬家；调用边变化；影响面（区分正式代码和测试代码）
- 重复实现检测：新增函数对比已有函数；另提供全库扫描模式
- 意图偏离检测（需配置 LLM，可选）
- 审查报告 JSON（带版本号），可输出为 Markdown 和 HTML
- CLI：`index`、`review`、`similar`、`serve`、`mcp`
- 本地 HTTP 服务、MCP 服务
- Web UI：改动清单、结构图、影响面、重复实现、意图偏离几个面板
- Web UI 浏览视图：符号搜索、邻居图（选中函数的调用方和被调用方，可逐层展开）、入口列表、源码面板；浏览器里独立使用，不依赖 IDE
- JetBrains 插件（PyCharm 和 IntelliJ IDEA 的免费版本都能用）：工具窗口嵌入 Web UI，点击跳转源码，一键审查未提交改动

**本次不做：**
- Java、TS 的提取和解析，以及 IDE PSI 导出（P3、P4）。不支持的语言文件在报告里按文件级 diff 列出，并标注"暂不支持结构分析"
- 全局代码地图（整个项目可缩放浏览）、模块聚类、LLM 模块摘要、从入口出发的时序图式调用链视图（P3）。P0–P2 的浏览视图只做以单个函数为中心的邻居图
- "新增但没人调用的代码"、架构分层规则、吞异常等可疑模式检查（验证中误报多或价值低）
- 名字匹配的兜底解析器。scip-python 失败时，报告给出提示，调用关系部分为空，不做降级匹配
- 增量索引；读取 AI agent 会话记录作为意图来源；PR 平台集成；VS Code 插件
- 把 Node 运行时打包进插件（已确认：用户自行安装 Node）

## 3. 现状分析

新项目，仓库为空。设计依据来自 2026-11-11 的验证（验证脚本已删除，结论如下）：

**codegraph 不适合作为解析层**
- 节点 id 由"路径 + 类型 + 名字 + 行号"生成，函数位置一变，id 就变。旧版本文件 55 个函数只有 39 个 id 能对上，按"文件 + 类型 + 限定名"匹配能对上 55 个。
- 在 clauve 的 Python 部分，codegraph 约 17% 的调用对是错的（911/5229），主要是同名乱连：正式代码的 `conn.execute` 被连到测试文件里的 `execute`。同时漏掉约 900 对 `repo.f()` 这类别名模块调用。
- 框架只在项目根目录检测，clauve 的 FastAPI 接口全部没被识别成入口。

**scip-python 可以作为 Python 解析层**
- 许可证：scip-python MIT，scip.proto Apache-2.0。
- clauve Python 部分（176 个文件、约 3.6 万行）全量索引 9–11s，内存约 1GB，输出约 7.5MB。没有增量索引。
- 不装 Python 依赖时，项目内调用关系与装依赖时完全一样，用户不需要准备 venv。scip-python 默认会调用 pip 读取当前 Python 环境的包列表，结果和耗时随用户环境变化；运行时固定传 `--environment` 指向一个内容为 `[]` 的文件，不调用 pip。
- 函数、方法、类的定义 occurrence 带 `enclosing_range`（覆盖装饰器行），引用 occurrence 不带。调用方等于"包含该引用的最内层定义范围"。引用后面紧跟 `(` 时是直接调用，否则是引用（如 `Depends(f)`）。
- 解析不到归属的第三方模块会被记到项目包名下，判断"是否项目内符号"要看它的定义是否落在项目文件里，不能只看包名。
- 非测试代码引用测试符号的边为 0；别名调用全部能解析。
- `--target-only` 只能拿到目标文件的出边，拿不到入边，审查场景不用它。

**Java（P3 才做，这里只记对设计的约束）**
- scip-java 要求项目能完整编译，bluewhale 在外网环境编不过，编不过时不输出索引。Java 精确调用关系将来由 IDE 插件的 PSI 提供。
- Java 有重载、接口到实现的派发、Lombok 等生成代码、写在接口上的路由，数据模型要提前预留。

### 可复用的已有代码

| 功能 | 已有实现（文件:类/方法） | 用在哪些阶段 |
| --- | --- | --- |
| 无（新项目） | — | — |

本项目用到的外部依赖：

| 依赖 | 用途 | 许可证 |
| --- | --- | --- |
| `@sourcegraph/scip-python` | Python 引用解析 | MIT |
| `scip.proto`（随代码生成 TS 类型，用 `@bufbuild/protobuf` 读取） | 读 index.scip | Apache-2.0 |
| `web-tree-sitter` + `tree-sitter-python`（wasm） | 提取层，wasm 版不需要本地编译 | MIT |
| `node:sqlite`（Node 内置） | 存储，不需要原生模块 | — |
| `@modelcontextprotocol/sdk` | MCP 服务 | MIT |
| `@xyflow/react` + `elkjs` | Web UI 结构图与布局 | MIT / EPL-2.0 |
| IntelliJ Platform Gradle Plugin 2.x | 插件构建 | Apache-2.0 |

## 4. 方案设计

### 4.1 整体思路

```
┌──────────── JetBrains 插件（Kotlin，薄壳）─────────────┐
│ 工具窗口 ── JCEF ── Web UI（React）                     │
│   启动/停止 codeinsight serve；JS 桥：openFile(path,line) │
└───────────────┬────────────────────────────────────────┘
                │ http://127.0.0.1:<随机端口>  + token
┌───────────────▼──────── packages/server ───────────────┐
│ 本地 HTTP API（给 Web UI / 插件）    MCP（给 AI agent）  │
└───────────────┬────────────────────────────────────────┘
┌───────────────▼──────── packages/core ─────────────────┐
│ git      取改动文件、用 git archive 导出 base 快照       │
│ extract  tree-sitter：符号、签名、函数体 hash、入口      │
│ resolve  解析器接口；ScipPythonResolver：SCIP → 边       │
│ store    SQLite：快照、文件、符号、边、入口              │
│ review   结构化 diff、影响面、报告组装                   │
│ similar  重复实现     intent  意图偏离（调 llm）         │
└─────────────────────────────────────────────────────────┘
packages/cli：index / review / similar / serve / mcp 命令入口
```

核心原则：

- **所有分析都在 core**。CLI、MCP、HTTP 只是不同的入口，插件只负责显示界面和跳转源码。
- **提取和解析分开**。结构化 diff 和重复实现只依赖提取层（快、单文件、不需要编译）；调用关系和影响面依赖解析层（准、整项目）。解析失败时前者照常输出。
- **不改用户仓库的代码和 git 状态**。所有数据写在数据目录，默认是仓库内的 `<repo>/.codeinsight/`，方便用户找到和清理，删仓库时一起删掉。可以用 `--data-dir` 或配置项改到别处。base 版本用 `git archive` 导出，不建 worktree，不切分支。
- **数据目录要被 git、IDE 和 pyright 排除**。数据目录里有快照源码副本，被扫描会出现重复的符号和查找结果：
  - git：初始化时在数据目录里写一个内容为 `*` 的 `.gitignore`，git 不会把它列为未跟踪文件，不需要改用户的 `.gitignore`。README 里同时建议用户把 `.codeinsight/` 加进项目的 `.gitignore`，让其他工具（很多工具读 `.gitignore`）也跳过它。
  - IDE：插件第一次在项目里启动时，如果 `.codeinsight` 还不是排除目录，弹通知"将 .codeinsight 标记为排除目录"，用户点击后用 `ModuleRootModificationUtil` 把它加入排除目录（这会改项目的 `.idea` 配置，所以要用户点击确认，不自动改）。不用插件的用户按 README 手动标记。
  - pyright / Pylance：仓库里有 `pyrightconfig.json` 或 `pyproject.toml` 的 `[tool.pyright]` 且自定义了 `exclude` 时，Pyright 默认的排除规则不再生效，`.codeinsight` 会被扫描。CLI 和 serve 初始化数据目录时检查这两处配置，`exclude` 里没有 `.codeinsight` 就在输出里给出警告和要加的配置行（只提示，不改用户文件）。codeinsight 自己运行 scip-python 用的是只含文件清单的副本，不受影响。
- **文件清单统一来源**。提交版本用 `git ls-tree -r --name-only <sha>`；工作区用 `git ls-files` 加上 `git ls-files --others --exclude-standard`（未跟踪且没被忽略的文件），再排除数据目录（默认的 `.codeinsight/` 或 `--data-dir` 指到的仓库内目录）。提取、解析、文件级 diff 都只看这份清单。
- **LLM 可选**。只有意图偏离检测需要 LLM，不配置时其他功能都能用。

仓库结构：

```
codeinsight/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  LICENSE
  packages/
    core/     src/{model,store,git,classify,config,extract,resolve,scip,snapshot,graph,review,similar,intent,llm,report}
    cli/      src/commands/*
    server/   src/{http,mcp}
    web/      Vite + React
  plugins/jetbrains/   Gradle + Kotlin
  docs/design/
```

运行要求：Node ≥ 22.13（`node:sqlite` 从这个版本起不需要命令行开关；Node 20 已于 2026-04 停止维护）。scip-python 作为 core 的 npm 依赖安装，通过子进程调用。

### 4.2 数据模型

SQLite 文件：`<dataDir>/index.db`。

**snapshots**：一次被分析的代码版本

| 字段 | 说明 |
| --- | --- |
| id | 自增 |
| kind | `commit` / `working` |
| commit_sha | `commit` 时为提交 sha；`working` 时为当时的 HEAD |
| content_key | `commit` 时等于 sha；`working` 时为 HEAD sha + 改动文件内容 hash，用于判断缓存是否可复用 |
| resolver_status | `ok` / `failed` / `skipped`，以及失败原因 |
| created_at, last_used_at | 用于清理：只保留最近使用的 8 个快照；正被其他进程使用（持有锁）或 10 分钟内用过的快照不清理 |

**files**

| 字段 | 说明 |
| --- | --- |
| snapshot_id, path | 联合主键，path 为相对仓库根目录的 POSIX 路径 |
| language | `python` / `java` / `typescript` / … / `unknown` |
| support_level | `full`（提取 + 解析）/ `structure`（只有提取）/ `none`（文件级 diff） |
| content_hash | 文件内容 sha1 |
| is_test, is_generated | 由 classify 判断，见 4.5 |

**symbols**

| 字段 | 说明 |
| --- | --- |
| snapshot_id, id | id = sha1(`symbol_key`) 前 16 位 |
| symbol_key | `<path>#<kind>#<qualified_name>#<signature>`，**不含行号**，跨版本稳定 |
| kind | `module` / `class` / `function` / `method` / `interface` / `enum` / … |
| name, qualified_name | qualified_name 用 `.` 连接，如 `BillingService.end_order`；嵌套函数为 `outer.<locals>.inner` |
| signature | 参与 symbol_key，只用于区分重载：Python 留空字符串；Java 填参数类型列表 |
| display_signature | 不参与 symbol_key，用于展示和判断签名变化：Python 为参数列表和返回注解原文（去掉多余空白和注释），如 `(org_id: str, conn=None) -> dict \| None` |
| parent_id | 所属类或外层函数 |
| start_line, end_line | 只用于定位和展示，含装饰器行 |
| body_hash | 函数体原文的 hash，判断"是否修改过" |
| norm_tokens | 归一化后的 token 序列（压缩存储），供相似度计算 |
| docstring | 截断到 500 字符 |
| is_test, is_generated | 继承所在文件，类级生成代码（如 Lombok）将来单独标 |

同一快照里 `symbol_key` 重复时（同名函数被重复定义），按出现顺序给 qualified_name 加 `#2`、`#3` 后缀。

每个支持的源文件都有一个 `kind=module` 的符号（qualified_name 为模块的点分路径，范围为整个文件），文件顶层代码（import、模块级调用、装饰器参数以外的顶层语句）里的引用归属到它。

**edges**

| 字段 | 说明 |
| --- | --- |
| snapshot_id, src_id, dst_id | 源和目标都是项目内符号 |
| kind | `call` / `reference` / `import` / `inherit` / `implement` / `dispatch` / `route_handler` |
| provenance | `scip` / `psi` / `name_match` / `framework` |
| confidence | `high` / `low` |
| path, line, col | 引用出现的位置（同一对符号多处引用时存多行） |

P0–P2 只会产生 `scip` + `high` 的边，以及入口识别产生的 `framework` 边。`implement`、`dispatch`、`psi`、`name_match` 留给 Java 和兜底解析器。

**entries**：入口

| 字段 | 说明 |
| --- | --- |
| snapshot_id, symbol_id | 入口处理函数 |
| kind | `http` / `exception_handler` / `task` / `cli` / `schedule` / `event` |
| framework | `fastapi` / `flask` / `django` / `celery` / `click` / … |
| detail | JSON，如 `{"method":"POST","path":"/orders/{id}"}` |

**reviews**：审查任务和报告，serve 重启后仍能查看

| 字段 | 说明 |
| --- | --- |
| id | 自增 |
| params | JSON，审查参数（base、head、working、intent 来源） |
| status | `running` / `done` / `failed`；进程启动时把遗留的 `running` 改成 `failed`（原因：进程中断） |
| report | `ReviewReport` JSON，done 时写入 |
| error | failed 时的原因 |
| created_at | 只保留最近 20 条 |

**缓存目录**

```
<dataDir>/
  .gitignore            内容为 *
  index.db
  snapshots/<sha>/      git archive 导出的 base 源码，用完保留，随快照清理
  scip/<content_key>.scip
  scip/empty-env.json   内容为 []，传给 scip-python 的 --environment
  llm-cache/<hash>.json
  locks/<content_key>.lock
```

**多进程并发**：serve、mcp、CLI 可能同时使用同一个数据目录。
- SQLite 开 WAL 模式，`busy_timeout` 10s。
- 构建某个快照（导出源码、提取、跑 scip-python、入库）前，用 `fs.open(..., 'wx')` 创建 `locks/<content_key>.lock`，文件里写 pid 和开始时间；已存在时等待对方完成后直接复用结果。持锁进程已不存在或超过 30 分钟时认为锁失效，删除后重新获取。
- 清理快照时跳过持有锁和 10 分钟内用过的快照。

### 4.3 接口设计

**审查报告 JSON（`ReviewReport`，`schemaVersion: 1`）**：CLI、HTTP、MCP、Web UI 共用，类型定义在 `packages/core/src/report/types.ts`，web 直接引用。

```ts
interface ReviewReport {
  schemaVersion: 1
  repo: string
  base: { ref: string; sha: string }
  head: { ref: string; sha: string; working: boolean }
  intent?: { source: 'arg' | 'file' | 'commits'; text: string }
  files: FileChange[]          // 全部改动文件，含不支持的语言
  modules: ModuleChange[]      // 按模块分组的函数级改动
  edgeChanges: EdgeChange[]
  duplicates: DuplicateFinding[]
  intentCheck?: IntentFinding[]   // 未配置 LLM 时不存在
  warnings: Warning[]          // 如 resolver_failed、language_unsupported、llm_not_configured
}
interface FileChange { path; status: 'added'|'removed'|'modified'|'renamed'; language; supportLevel; additions; deletions; isTest }
interface ModuleChange { module: string; symbols: SymbolChange[] }
interface SymbolChange {
  key: string; kind; name; qualifiedName; path; startLine; endLine
  change: 'added' | 'removed' | 'modified' | 'signature_changed' | 'moved'
  displaySignature: string         // 对应 symbols.display_signature，removed 取 base
  displaySignatureBefore?: string  // modified / moved 且 display_signature 变化时给出旧值
  movedFrom?: string
  entry?: { kind; framework; detail }
  callers: { prod: number; test: number; topProd: SymbolRef[] }   // 取 head；removed 取 base
  impact: { depth: number; prod: number; test: number }           // 默认 2 层
}
interface EdgeChange { src: SymbolRef; dst: SymbolRef; kind; change: 'added' | 'removed' }
interface DuplicateFinding { symbol: SymbolRef; candidates: { symbol: SymbolRef; score: number; reasons: string[] }[] }
interface IntentFinding { verdict: 'mentioned' | 'unmentioned' | 'unclear'; summary: string; symbols: SymbolRef[]; modules: string[] }
```

**CLI**

```
codeinsight index   [--repo .] [--ref REF] [--data-dir DIR]     # 不带 --ref 时索引工作区
codeinsight review  [--repo .] [--base REF] [--head REF | --working]
                    [--intent TEXT | --intent-file PATH] [--no-llm]
                    [--format json|md|html] [--out PATH] [--open] [--data-dir DIR]
codeinsight similar [--repo .] [--symbol KEY | --all] [--min-score 0.6] [--format json|md]
codeinsight serve   [--repo .] [--port 0] [--open] [--data-dir DIR]
                    # 启动后在 stdout 打一行 JSON：{"port":..,"token":"..","url":".."}；--open 时用系统默认浏览器打开 url
codeinsight mcp     [--repo .] [--data-dir DIR]              # stdio MCP
```

默认值：`--working` 未指定且没有 `--head` 时审查未提交改动；`--base` 默认 `HEAD`（审查未提交改动时）或 `<head>~1`。`--intent` 不填且审查的是提交区间时，用区间内的提交说明作为意图。退出码：0 成功；1 参数或 git 错误；解析失败不算错误，写进 warnings。

**HTTP API**（只监听 127.0.0.1，所有请求带 `Authorization: Bearer <token>`）

| 方法 路径 | 说明 |
| --- | --- |
| `GET /api/status` | 仓库、Node 版本、LLM 是否配置、最近的报告（从 reviews 表读） |
| `POST /api/reviews` | 入参同 CLI review；异步执行，返回 `{id}` |
| `GET /api/reviews/:id` | `{status: running|done|failed, progress, report?}` |
| `GET /api/source?snapshot=&path=&start=&end=` | 返回源码片段，浏览器里看源码用 |
| `GET /api/symbols/:snapshot/:id/callers?depth=` | 调用方树 |
| `GET /api/symbols/:snapshot/:id/callees?depth=` | 被调用方树 |
| `GET /api/symbols/:snapshot/:id` | 单个符号详情：位置、签名、docstring、入口信息、调用方和被调用方数量 |
| `GET /api/symbols/search?q=&kind=&limit=` | 在当前工作区快照中按名字搜索（前缀和子串匹配，名字完全相同的排前面，测试代码排后面） |
| `GET /api/entries?kind=&framework=` | 入口列表 |
| `POST /api/index` | 对当前工作区建索引（异步），返回 `{id}`；`GET /api/status` 返回索引进度和最近一次完成时间 |
| `GET /api/similar?snapshot=&id=` | 单个函数的重复实现候选 |
| `GET /` | Web UI 静态文件 |

认证：serve 输出的 url 带 `?token=`。首次请求 `/` 时校验 token，通过后设置名为 `ci_<端口>` 的 `HttpOnly; SameSite=Strict` cookie 并重定向（cookie 不按端口隔离，同时开多个项目的 serve 时名字带端口才不会互相覆盖，JCEF 在整个 IDE 内共用 cookie）到不带 token 的地址；之后静态文件和 API 都接受这个 cookie 或 `Authorization: Bearer <token>` 头（给 CLI 和测试用），都没有时返回 401。

快照失效：路径里的 snapshot id 已被清理或数据库重建后，接口返回 410 和 `{error:"snapshot_gone"}`。Web UI 收到后重新取 `/api/status` 拿当前快照，提示"索引已更新"并回到入口列表；审查报告页提示"该报告对应的快照已清理，调用方详情不可用"，改动清单照常显示（报告本身存在 reviews 表里）。

**MCP 工具**（不重复 codegraph 已有的"查代码"能力，只做审查相关的）

| 工具 | 入参 | 输出 |
| --- | --- | --- |
| `review_changes` | `base?`, `head?`, `working?`, `intent?` | 精简 Markdown：按模块的改动清单、调用方多的改动、重复候选、意图偏离、警告 |
| `get_impact` | `symbol`（名字或 key）, `depth?` | 正式代码和测试代码调用方，按层列出 |
| `find_similar` | `symbol` 或 `code`（一段尚未写入的代码） | 相似的已有函数及位置，供 AI 写代码前查重 |

- `symbol` 按名字查到多个符号时（如 clauve 里有两份 `insert_audit_log`），不猜，返回候选列表（key、路径、行号），提示用 key 再调一次。
- `get_impact`、`find_similar` 在当前工作区还没有可复用快照时，先同步建索引（共用快照构建流水线），再返回结果；超时（默认 300s）时返回错误说明，不返回空结果。

**插件与 Web UI 的 JS 桥**：插件在页面里注入 `window.codeinsightHost = { openFile(path, line), reviewWorking() }`。Web UI 在每次点击时检查它是否存在（不在页面加载时检查，避免注入晚于页面脚本）：存在时调用 `openFile`，否则调用 `/api/source` 在页面里显示源码。`removed` 的函数在工作区里已不存在，一律用 `/api/source` 显示 base 快照里的源码。

### 4.4 关键流程

**review 流程**

1. **确定版本和改动文件**：解析 base、head 为 sha。`git diff --name-status -M base head`（或对比工作区，包含未跟踪文件）得到改动文件，按语言分出 `full` / `structure` / `none`。
2. **准备快照**：
   - base 是提交：`git archive <sha> | tar -x -C <dataDir>/snapshots/<sha>`，已存在就复用。
   - head 是提交：同上。head 是工作区：把文件清单里支持语言的文件和 `pyproject.toml`、`setup.cfg`、`pyrightconfig.json` 复制到 `<dataDir>/snapshots/<content_key>/`，scip-python 在这份副本上运行。这样不在清单里的目录（如没被 git 忽略规则覆盖的 `venv/`、`build/`）不会被 scip-python 扫描。源码展示和跳转仍用工作区里的文件。
3. **提取**（两个版本可并行，走快照构建流水线，见 4.5）：对文件清单里所有支持语言的文件做 tree-sitter 提取，写入 files、symbols、entries。这一步不依赖 scip-python，总会执行，第 5、8 步需要的"已有函数"都来自这里。
4. **解析**（两个版本可并行）：对每个快照，`scip/<content_key>.scip` 已有就复用，否则运行 scip-python（`--cwd <快照根目录> --environment <dataDir>/scip/empty-env.json --output <dataDir>/scip/<key>.scip`，超时默认 300s），按下文转换成边写入 edges。失败或超时时标 `resolver_status=failed`，报告加 warning，跳过第 6 步；第 5、7、8、9 步照常执行。
5. **函数级 diff**：按 `symbol_key` 匹配两个版本的符号：
   - 只在 head：`added`；只在 base：`removed`
   - 两边都有、body_hash 不同：`modified`
   - 两边都有、display_signature 不同：仍为 `modified`，带 `displaySignatureBefore`（Python 的签名变化都走这条）
   - qualified_name 相同、signature 不同：`signature_changed`（只在 Java 重载场景出现，Python 不会出现）
   - `removed` 和 `added` 之间找 `moved`：只在 kind、name 相同且 body_hash 相同或函数体相似度 ≥ 0.9 的组合里配对，一对一匹配——按"body_hash 相同 > 相似度高 > 路径相似度高"排序后贪心选取，每个符号只用一次，配不上的保持 `removed` / `added`
6. **调用边变化和影响面**：
   - 边变化：对改动符号，比较两个版本出边的目标 `symbol_key` 集合。
   - 调用方：`added`、`modified`、`moved` 在 head 图上查，`removed` 在 base 图上查。按调用方是否为测试代码分开计数，正式代码调用方按数量列出前 5 个。
   - 影响面：沿 `call` 和 `reference` 边向上 BFS 默认 2 层。
7. **模块分组**：模块 = 文件所在目录，取前 `moduleDepth` 层（默认 3，可在配置里改）。
8. **重复实现**：对 `added` 和 `moved` 的非测试函数，调用 similar 模块，见下文。
9. **意图偏离**（配置了 LLM 且未加 `--no-llm`）：调用 intent 模块，见下文。
10. **组装报告**：不支持的语言文件只出现在 `files` 里，并加 `language_unsupported` warning。

**SCIP → 边**

1. 读 index.scip 的 documents，不在文件清单里的 document 直接丢弃。对每个 document，收集带 `enclosing_range` 的定义 occurrence，按文件建立范围区间表。
2. 用提取层的符号（同文件、同名、起始行在 enclosing_range 内）对应到 `symbol_key`。对应不上的定义记数，超过 1% 时写 warning，便于发现提取和 SCIP 不一致。
3. 对每个非定义 occurrence：找它所在的最内层定义范围作为 src；目标 SCIP 符号的定义 document 在本快照内时，作为 dst；否则丢弃（外部符号）。
4. 引用位置后面第一个非空白字符是 `(` 时为 `call`，否则为 `reference`。import 语句中的 occurrence 记为 `import`，src 为模块符号。
5. 自己引用自己的边（递归除外）丢弃。

**入口识别（Python）**

用 tree-sitter 查装饰器和调用，不依赖框架检测：

| 框架 | 规则 |
| --- | --- |
| FastAPI / Flask | `@<x>.(get|post|put|patch|delete|head|options|api_route|route)(<path>, ...)` |
| FastAPI | `@<x>.exception_handler(...)`、`@<x>.middleware(...)`、`@<x>.on_event(...)` |
| Django | `urls.py` 中 `path(...)` / `re_path(...)` 的第二个参数（函数或 `View.as_view()`） |
| Celery | `@<x>.task`、`@shared_task` |
| click / typer | `@<x>.command`、`@click.command`、`@<x>.group` |

入口函数在报告里带 `entry` 字段。界面上调用方为 0 的入口函数显示"入口"标签，不显示"无调用方"。

**重复实现（similar）**

1. 候选：同语言、不在本次改动里、非测试的函数中，满足以下任一条件：名字相同；名字按 snake/camel 切词后 token 集合 Jaccard ≥ 0.6；函数体相似度达到阈值。
2. 函数体相似度：对 tree-sitter token 序列做归一化（标识符替换为 `ID`，数字替换为 `NUM`，**字符串字面量保留原文**，避免把只有 SQL 不同的仓储样板代码误判为重复），计算 5-gram shingle 的 Jaccard。用 MinHash（128 个 hash）建 LSH 索引，全库扫描时只对 LSH 命中的组合算精确值。
3. 排除：新函数直接调用候选函数（透传或包装，不算重复）；函数体不足 3 行。
4. 评分：`score = 0.5 * 函数体相似度 + 0.3 * 名字相似度 + 0.2 * 签名形状相似度`（参数个数、是否有返回值），默认只报告 ≥ 0.6 的候选，每个函数最多 3 个。`reasons` 写明是哪几项命中的。
5. 同名重复：不同模块里名字完全相同、签名形状也相同的非测试函数，单独作为"同名重复"候选报告（`reasons` 标明同名重复），不受第 3 步"函数体不足 3 行"和 0.6 门槛的限制。用于发现"一份已改为调用公共函数、另一份还是旧实现"这类各自演变的复制（如 clauve 的两份 `select_user_org_id`）。（2026-11-11 确认）
6. 已知问题：只有 SQL 不同的仓储层短函数（如 `select_X_by_id`、`insert_*`）函数体相似度偏高，误报较多。同名重复规则也会报出常见的同名小函数（如各模块的 `_use`、`register`、`main`、不同类的 `__init__`）。先保持现有评分和阈值，到阶段 6 在界面上看过实际效果后再调整。

**意图偏离（intent）**

1. 意图文本：`--intent` / `--intent-file`，或提交区间的提交说明。没有任何意图文本时跳过，加 warning。
2. 输入给 LLM 的只有结构摘要，不含函数体：按模块列出改动函数的 change 类型、qualified_name、签名、docstring 首行，以及新增文件列表。超过 8000 token 时按模块截断，并在 warning 里说明。
3. 要求 LLM 输出 JSON：把改动分成若干组，每组标 `mentioned` / `unmentioned` / `unclear`，给一句说明和所含符号 key。返回的 key 不在改动清单里的丢弃。
4. 缓存 key = hash(模型名 + prompt 版本 + 意图文本 + 结构摘要)。

**LLM 配置**：`codeinsight.config.json`（仓库根目录，可选）或环境变量。支持 `anthropic` 和 `openai-compatible`（Ollama、本地模型也走这个）。默认不启用。首次调用前在 CLI 输出里提示"将发送结构摘要到 <provider>"。

**浏览流程（浏览器或插件里都可用）**

1. `serve` 启动时检查当前工作区是否已有可复用的快照（按 content_key）。没有就在后台建索引，页面显示进度；建好之前搜索框不可用。
2. 页面默认显示入口列表（按 kind 和 framework 分组）和搜索框。
3. 选中一个函数后显示邻居图：中心是该函数，左边是调用方，右边是被调用方，默认各 1 层，点击节点上的"展开"再加载一层（每次调 `callers` / `callees`，`depth=1`）。单个方向超过 30 个节点时折叠成"还有 N 个"，点击后按文件分组列出。测试代码节点默认隐藏，可以切换显示。
4. 点击图上的节点：把它设为新的中心，旧中心保留在面包屑里可以返回。双击节点或点击详情里的位置：有 JS 桥时在 IDE 中打开，否则在源码面板显示。
5. 源码面板显示整个函数，函数里出现的项目内调用加下划线，点击跳到对应函数的邻居图（用 edges 表里的 path/line/col 定位）。
6. 工作区文件改动后不自动重建索引，页面顶部显示"索引建于 <时间>"和"重新建索引"按钮。

**插件流程**

1. 打开工具窗口时启动 `codeinsight serve --repo <项目根目录>`，读取 stdout 第一行拿到端口和 token。Node 按顺序查找：设置里的路径 → `EnvironmentUtil.getEnvironmentMap()` 里的 PATH（macOS 从图形界面启动 IDE 时，进程 PATH 里没有 Homebrew / nvm 的路径，要用登录 shell 的环境）→ 常见安装目录。启动子进程时也用这份环境。找不到 Node ≥ 22.13 或 codeinsight 时，在工具窗口显示安装指引。
2. `JBCefApp.isSupported()` 为 false 时，工具窗口不嵌页面，显示"在浏览器中打开"按钮（`BrowserUtil.browse(url)`），此时没有 JS 桥，跳转靠页面里的源码面板。支持时 JCEF 加载 `http://127.0.0.1:<port>/?token=...`，在 `onLoadEnd` 时用 `JBCefJSQuery` 注入 JS 桥。
3. "审查未提交改动"按钮：调用 `POST /api/reviews {working:true}`，页面轮询进度。
4. 点击函数：JS 桥 `openFile(path, line)` → `FileEditorManager` 打开文件并跳转到行。
5. 项目关闭或 IDE 退出时结束 serve 进程。

### 4.5 公共逻辑

| 公共逻辑 | 位置 | 负责实现的阶段 |
| --- | --- | --- |
| `symbol_key` 生成与解析、id 计算 | `packages/core/src/model/symbol-key.ts` | 阶段1 |
| 测试代码和生成代码判断（`tests/`、`test_*.py`、`*_test.py`、`conftest.py`，可在配置中追加 glob） | `packages/core/src/classify/` | 阶段1 |
| git 操作：解析 ref、改动文件列表、文件清单（见 4.1）、`git archive` 导出、工作区内容 hash | `packages/core/src/git/` | 阶段1 |
| 数据目录：默认位置、初始化（含 `.gitignore`）、pyright exclude 检查、快照锁、快照清理 | `packages/core/src/store/data-dir.ts` | 阶段1 |
| 配置读取（`codeinsight.config.json` + 环境变量 + 数据目录） | `packages/core/src/config/` | 阶段1 |
| 语言识别与 support_level | `packages/core/src/model/language.ts` | 阶段1 |
| 快照构建流水线：准备源码 → 提取 → scip-python → 转换入库，按 content_key 复用，提取和解析分开记录状态（`index`、review、serve 建索引、MCP 共用） | `packages/core/src/snapshot/build.ts` | 阶段2 |
| tree-sitter token 归一化（similar 和 moved 判断共用） | `packages/core/src/extract/normalize.ts` | 阶段2 |
| 图遍历：调用方 / 被调用方按层查询，可按测试代码过滤（审查的影响面和浏览视图共用） | `packages/core/src/graph/traverse.ts` | 阶段3 |
| `ReviewReport` 类型定义（core、server、web 共用） | `packages/core/src/report/types.ts` | 阶段3 |
| 报告转 Markdown（CLI `--format md` 和 MCP 共用） | `packages/core/src/report/markdown.ts` | 阶段3 |
| LLM 客户端 | `packages/core/src/llm/` | 阶段4 |

### 4.6 备选方案

- **继续用 codegraph 做索引**：上手最快，但它的解析层在 Python 上有约 17% 的错连，节点 id 不跨版本稳定，审查需要的功能要依赖它 `dist/` 下的内部模块。不采用。
- **完全自己写 Python 名字解析**：要处理别名导入、类层次、类型推断，工作量以月计，精度也比不上基于 Pyright 的 scip-python。不采用。
- **base 版本用 `git worktree`**：会在用户仓库的 `.git` 里留下 worktree 记录。改用 `git archive` 导出到数据目录，不改用户仓库。
- **只解析改动文件（`--target-only`）**：拿不到入边，无法统计调用方。只在后续"快速预览"场景考虑。
- **插件里用 Kotlin 直接读 SQLite**：会让分析逻辑分散在两种语言里，AI 通过 MCP 拿到的和人在插件里看到的可能不一致。不采用。
- **Web UI 用 Sigma.js（WebGL）**：适合上万节点的全局地图。审查视图只画改动函数和 1–2 层邻居，节点通常在几百以内，React Flow + ELK 布局更清楚，交互更好做。全局地图（P3）时再评估。

## 5. 兼容性与上线

- 新项目，没有已有用户。
- 报告 JSON 带 `schemaVersion`，Web UI 和插件遇到不认识的版本时提示升级。
- `index.db` 记录 schema 版本；版本不一致时直接删库重建（数据都可以从代码重新算出来，不做迁移）。
- 发布：core/cli/server 打包成一个 npm 包 `codeinsight` 发布，Web UI 构建产物打进这个包；插件发布到 JetBrains Marketplace，最低支持 2025.1，只依赖 `com.intellij.modules.platform`。

## 6. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| scip-python 没有增量索引，大项目每次全量很慢、内存高 | 审查等待时间长 | base 按 sha 缓存，工作区按内容 hash 缓存；两个版本并行跑；超时后输出不含调用关系的报告；报告里显示每一步耗时 |
| scip-python 在某些项目上失败（语法错误、特殊目录结构） | 没有调用关系 | 提取层结果照常输出；warning 写明失败原因和 scip-python 的 stderr 末尾 20 行 |
| 提取层和 SCIP 的函数范围对不上（装饰器、嵌套函数、lambda） | 边丢失 | 按"同文件 + 同名 + 起始行落在范围内"对应；对不上的比例超过 1% 时出 warning；用 clauve 做回归 |
| 依赖 scip-python 版本行为（如 enclosing_range 字段） | 升级后边数变化 | 锁定版本；集成测试检查 clauve 上的关键数字 |
| 重复实现误报（分层透传、样板代码） | 报告噪声大，用户不再看 | 排除直接调用关系；保留字符串字面量；阈值可配；每个函数最多 3 个候选 |
| LLM 输出不稳定、发送代码信息到外部 | 意图检查结果不可靠；隐私顾虑 | 只发结构摘要，不发函数体；首次调用提示；输出按 JSON 校验，不合格重试 1 次后放弃并出 warning |
| 插件依赖用户本机 Node | 安装门槛 | 工具窗口给出明确的安装指引和 Node 路径设置；P0–P2 不打包 Node，有用户反馈再评估 |
| `node:sqlite` 在部分 Node 版本里仍标记为实验特性，API 可能调整 | Node 升级后存储层报错 | 只通过 store 模块访问数据库，换实现只改一处；CI 覆盖 Node 22 和最新 LTS |
| 多个进程（serve、mcp、CLI）同时用一个数据目录 | 重复跑 scip-python、清理掉别人正在用的快照 | 快照锁和清理规则见 4.2"多进程并发" |

## 7. 测试方案

**单元测试（vitest，每个阶段跟着写）**
- symbol_key、classify、git 辅助函数
- 提取层：用 `packages/core/test/fixtures/py-basic/` 下的小样例覆盖类、方法、嵌套函数、装饰器、重复定义、各框架入口
- SCIP 转换：用 fixtures 跑真实的 scip-python，检查别名导入（`from . import repo as r; r.f()`）能连上、调用和引用能区分、外部符号被丢弃
- 函数级 diff：用测试里临时 `git init` 的仓库，构造新增、删除、修改、搬家
- similar：构造重复、透传包装、只有 SQL 不同的样板代码三种情况
- intent：用假的 LLM 客户端返回固定 JSON，检查解析、key 过滤、缓存

**集成测试（需要本机有 clauve，环境变量 `CODEINSIGHT_CLAUVE` 指向它，如 `~/project/Clauve`，没有时跳过）**
- 全部使用 `--data-dir` 指到临时目录，不在 clauve 里写任何文件；测试结束检查 `git -C $CODEINSIGHT_CLAUVE status --porcelain` 输出与测试前一致
- 所有数字固定在提交 `80cf8e1` 上（用 `index --ref 80cf8e1` 的提交快照，不用工作区）：`insert_audit_log`（server/modules/lease/repository.py）调用方 7 个（正式 7、测试 0），`select_release_by_version` 调用方 30 个（正式 14、测试 16），正式代码指向测试代码的边为 0。调用方按不同的调用函数计数，这些数字已在 80cf8e1 上用 `git grep` 逐个核对调用点得出（9d1b880 新增了 `revoke_device_leases` 里的一处调用，所以比白天验证时的 6 多 1）。跑不出这些数字算阶段失败，不改期望值
- `review --base fc4c752~1 --head fc4c752`：`server/console/modules/console/admin_api.py` 下出现 16 个 `added` 函数；改动中的非 Python 文件出现在 `files` 并带 `language_unsupported` warning
- `similar --all`：结果包含 `select_org_by_id`、`_ensure_same_org`、`select_user_org_id`、`insert_lease` 四组

**手工验证**
- 不装 IDE，用 `codeinsight serve --open` 在浏览器里浏览 clauve：入口列表、搜索、邻居图展开、源码面板跳转
- 在 PyCharm 和 IntelliJ IDEA 里各装一次插件（用不需要付费许可的版本：2025.1 起 PyCharm 合并为一个发行版，核心功能免费），打开一个小 Python 项目，改几个函数后点"审查未提交改动"，检查面板内容和点击跳转

## 8. 开发计划

- [x] 阶段1：项目骨架、数据模型与公共基础
  - 涉及模块：根目录配置、packages/core/src/{model,store,classify,git,config}
  - 依赖：无
  - 验证方式：独立
  - 内容：pnpm monorepo（core、cli、server、web 四个包，TS 严格模式，vitest，eslint）；LICENSE；4.2 节全部表结构和 schema 版本检查；symbol_key、语言识别、classify、git 辅助函数（含文件清单）、配置读取、数据目录（默认位置、初始化含 `.gitignore`、pyright exclude 检查、快照锁、快照清理）；store 基于 `node:sqlite`，WAL + busy_timeout
  - 完成标准：`pnpm install && pnpm -r build && pnpm -r test` 通过；store 测试覆盖建表、写入读取五类实体（含 reviews）、schema 版本不一致时重建；git 测试在临时仓库里覆盖提交区间、工作区（含未跟踪文件、排除被忽略文件和仓库内数据目录）、`git archive` 导出；数据目录测试覆盖：初始化后 `git status --porcelain` 不出现 `.codeinsight`；`pyrightconfig.json` 自定义了 exclude 且不含 `.codeinsight` 时给出警告，含时不警告；锁测试覆盖两个进程抢同一把锁时后者等待、持锁进程已退出时锁被回收、清理跳过持锁快照
  - 验证：`pnpm install && pnpm -r build && pnpm -r test`（core 33/33）、`pnpm lint` 通过；独立验证两轮共 16 个问题已修：快照锁改为 link 原子创建 + guard 保护下确认 token 再删除、只释放自己的锁、损坏锁 5 秒后按失效回收，锁测试改为 6 个真实子进程 × 3 轮检查持锁区间不重叠；提交导出由 `git archive` 改为 `ls-tree` + `cat-file --batch` 写出（不受 `.gitattributes` 的 export-ignore / export-subst 影响，与文件清单一致，跳过子模块，目标目录先清空）；git 函数统一按仓库根目录工作并固定 diff 参数（`--no-relative --no-ext-diff --ignore-submodules=all`）；新增 core 日志（stderr，`CODEINSIGHT_LOG` 控制级别）；pyright exclude 按 glob 匹配；`index.db` 损坏时重建。未处理：guard 文件自身的失效回收（持有者卡住超过 10 秒）仍有小概率竞争；schema 版本不一致删库时不检查旧版进程是否还开着库。改动 packages/core/src/{store/data-dir.ts,store/db.ts,git/index.ts,log.ts}、packages/core/test/

- [x] 阶段2：Python 提取层与 scip-python 解析
  - 涉及模块：packages/core/src/{extract,resolve,scip,snapshot}、packages/core/test/fixtures/、packages/cli/src/commands/index.ts
  - 依赖：阶段1
  - 验证方式：独立
  - 内容：web-tree-sitter 加载 Python 语法；提取类、函数、方法、嵌套函数、docstring、body_hash、norm_tokens；display_signature、module 符号；入口识别（4.4 节表格）；token 归一化；解析器接口 `Resolver` 与 `ScipPythonResolver`（运行 scip-python 并传 `--environment`、读取 index.scip、按 4.4 节转换成边、顶层代码引用归属 module 符号）；快照构建流水线（4.5）；`codeinsight index` 命令（含 `--ref`）
  - 完成标准：`pnpm --filter @codeinsight/core test` 通过，fixtures 覆盖别名导入、调用与引用区分、外部符号丢弃、各框架入口；单测覆盖 scip-python 失败时提取结果照常入库、`resolver_status=failed`；设置 `CODEINSIGHT_CLAUVE` 后集成测试通过：在 80cf8e1 上 lease 版 `insert_audit_log` 调用方 7（正式 7、测试 0）、`select_release_by_version` 调用方 30（正式 14、测试 16）、正式代码到测试代码的边为 0，且 clauve 的 `git status --porcelain` 不变
  - 验证：`CODEINSIGHT_CLAUVE=~/project/Clauve pnpm --filter @codeinsight/core test` 66/66（clauve 80cf8e1：lease 版 `insert_audit_log` 调用方 7（正式 7、测试 0）、`select_release_by_version` 30（正式 14、测试 16）、正式→测试边 0，clauve `git status --porcelain` 前后为空）、`pnpm -r build`、`pnpm lint` 通过；独立验证三轮，问题已修：快照根没有 pyright 配置时在快照副本里写 `{}` 的 pyrightconfig.json，防止 Pyright 把上层工作区当项目根；拿锁后一律重新检查复用，等待过别人时失败结果也直接复用；解析失败的快照下次只重跑解析（提取结果复用）；调用判断只看同一条语句（扫描续行，处理字符串内反斜杠换行和 CRLF）；同名多个定义时引用连到最后一个；docstring 跳过开头注释；去缩进支持 tab；display_signature 保留字符串原文、只去参数列表最外层的尾逗号。取舍：scip-python 固定带 `--project-version`，`--cwd` 用真实路径，索引为空按失败；body_hash 为「装饰器 + 函数体」（不含签名，签名变化看 display_signature），只改装饰器算 modified；类同样含类装饰器和类体（含方法），module 为整个文件，类和模块是否列为 modified 由阶段 3 处理；SCIP 定义对不上超过 1% 时状态仍为 ok，说明写进 resolver_error；构建 warning 不入库，阶段 3 从 resolver_status / resolver_error 生成。改动 packages/core/src/{extract,resolve,scip,snapshot}、packages/core/src/store/db.ts（snapshotStats）、packages/cli/src/commands/index.ts、packages/core/test/

- [x] 阶段3：结构化 diff、影响面与审查报告
  - 涉及模块：packages/core/src/{review,report,graph}、packages/cli/src/commands/review.ts
  - 依赖：阶段2
  - 验证方式：独立
  - 内容：4.4 节 review 流程第 1–7、10 步（快照准备、两个版本并行走快照构建流水线、函数级 diff 含签名变化和一对一 moved 匹配、调用边变化、调用方和影响面、模块分组、不支持语言的文件级列出）；图遍历公共逻辑（调用方和被调用方两个方向）；`ReviewReport` 类型；Markdown 和 JSON 输出；`codeinsight review` 命令（`--format json|md`）
  - 完成标准：单测在临时仓库里覆盖 added / removed / modified（含 `displaySignatureBefore`）/ moved（含两个同名函数同时搬家时一对一配对正确）、解析失败时仍输出函数级 diff 和 warning；集成测试 `review --base fc4c752~1 --head fc4c752 --format json` 中 admin_api.py 有 16 个 `added` 函数，非 Python 文件带 `language_unsupported`；同一 base 第二次审查时不再运行 scip-python（日志里能看到缓存命中）
  - 验证：`CODEINSIGHT_CLAUVE=~/project/Clauve pnpm -r test`（core 92/92）、`pnpm -r build`、`pnpm lint` 通过；clauve `review --base fc4c752~1 --head fc4c752 --format json` 中 admin_api.py 16 个 added、非 Python 文件带 `language_unsupported`，同一 base/head 第二次审查日志有 `snapshot_cache_hit` 且不运行 scip-python；80cf8e1 上用审查实际使用的调用方统计核对仍为 7 / 30（14+16）/ 0；clauve `git status --porcelain` 前后为空。独立验证一轮，7 个问题已修：同名重复定义按组内 body_hash 再按顺序配对；类自身 hash 忽略单独的 `pass` / `...`；moved 配对先按 body_hash 直接配，剩余的 shingle 只算一次；改动里没有支持语言的文件时不建快照；首个提交与空树比较；显式 `working:false` 且没有 head 时审查 HEAD~1..HEAD。取舍：类的 body_hash 只含类装饰器和类体中除方法、嵌套类外的部分（改方法不连带类），`SCHEMA_VERSION` 升到 2，旧库打开时重建；module 符号不进改动清单；只对改动文件做符号 diff；moved 相似度阈值 0.9，排序为 body_hash 相同 > 相似度 > 路径相似度 > qualified_name 相同 > key；递归不算调用方；影响面沿 call + reference 向上 `impactDepth` 层，不含 import；边变化比较 (kind, 目标 key)，base 目标搬家后先映射到 head；任一边解析失败时边变化为空、该边调用方和影响面为 0 并带 `resolver_failed`；报告在方案字段外加了 snapshotId、SymbolChange.id/isTest、FileChange.oldPath、Warning 结构、timings；CLI 只支持 json/md（html 属阶段 6），不写 reviews 表（属阶段 5）。改动 packages/core/src/{review,report,graph}、packages/cli/src/commands/review.ts，以及 extract/python.ts、extract/normalize.ts、store/{schema,db}.ts、git/index.ts、snapshot/build.ts

- [x] 阶段4：重复实现与意图偏离
  - 涉及模块：packages/core/src/{similar,intent,llm}、packages/cli/src/commands/similar.ts
  - 依赖：阶段3
  - 内容：similar 模块（候选、MinHash/LSH、评分、排除规则）并接入 review 第 8 步；`codeinsight similar` 命令；LLM 客户端（anthropic、openai-compatible，配置、缓存、首次提示）；intent 模块并接入 review 第 9 步；`--intent`、`--intent-file`、`--no-llm`
  - 完成标准：单测覆盖重复、透传包装、SQL 样板三种情况，以及 intent 的假 LLM 解析、非法 key 过滤、缓存命中；集成测试 `similar --all` 包含 `select_org_by_id`、`_ensure_same_org`、`select_user_org_id`、`insert_lease`；未配置 LLM 时 review 正常完成并带 `llm_not_configured` warning
  - 验证：`CODEINSIGHT_CLAUVE=~/project/Clauve pnpm -r test`（core 121/121、cli 5/5）、`pnpm -r build`、`pnpm lint` 通过；clauve 80cf8e1 上 `similar --all` 四组都在（insert_lease 0.821、_ensure_same_org 0.848、select_org_by_id 0.75、select_user_org_id 0.5 同名重复），有候选的函数 141 个；7 / 30（14+16）/ 0 不变，clauve `git status --porcelain` 前后为空；未配置 LLM 时 review 带 `llm_not_configured`。决定（2026-11-11，主管经另一会话转达）：加 4.4 第 5 条同名重复规则；样板误报见第 6 条，阶段 6 再调。取舍：`similar` 加 `--ref`、`--data-dir`；函数体相似度 ≥ 0.5 作为候选；签名形状 = 0.5 × 参数个数比 + 0.5 × 是否有返回值一致（不计 self/cls 和单独的 `*`、`/`）；函数体行数按结束行 − 开始行；透传/包装按两者间任一方向的 call/reference 边排除；`--all` 每对只报一次；LLM 摘要用真实 symbol key，token 按字符数估算；anthropic 默认模型 `claude-sonnet-5-5`；`--no-llm` 记 `llm_disabled`（info），请求失败记 `llm_failed` 不重试，两次不合格记 `llm_invalid_response` 不写缓存；首次调用提示每进程每个 provider+模型一次。改动 packages/core/src/{similar,intent,llm}、review/llm-steps.ts、review/{index,versions}.ts、report/{types,markdown}.ts、config/index.ts，packages/cli/src/commands/{similar,workspace}.ts

- [x] 阶段5：本地 HTTP 服务与 MCP
  - 涉及模块：packages/server/src/{http,mcp}、packages/cli/src/commands/{serve,mcp}.ts
  - 依赖：阶段4
  - 验证方式：独立
  - 内容：4.3 节 HTTP API（只监听 127.0.0.1、随机端口、token 校验、cookie / Bearer 认证、异步审查任务与进度（写 reviews 表）、异步建索引与进度、snapshot 失效返回 410、源码片段、调用方和被调用方树、符号详情、符号搜索、入口列表、相似候选、静态文件托管）；启动时 stdout 输出端口、token、url，`--open` 打开浏览器；启动时没有可复用快照就在后台建索引；MCP 三个工具 `review_changes`、`get_impact`、`find_similar`（`find_similar` 支持传一段代码；同名时返回候选；没有索引时先建索引）
  - 完成标准：server 测试覆盖：无 token 或错误 token 返回 401，带 `?token=` 访问 `/` 后凭 cookie 能访问 API 和静态文件；serve 重启后 `GET /api/reviews/:id` 仍能取到之前的报告；已清理的 snapshot 返回 410；`/api/source` 拒绝仓库外路径（如 `../`）；审查任务和建索引任务都能从 running 到 done；在 fixtures 仓库上搜索能按"名字完全相同 > 前缀 > 子串、测试代码在后"排序，`callers` / `callees` 返回结果与 edges 表一致；MCP 测试用 SDK 客户端走 stdio 调用三个工具都返回非空结果，`get_impact` 传有两份同名定义的名字时返回候选列表
  - 验证：`CODEINSIGHT_CLAUVE=~/project/Clauve pnpm -r test`（core 123、server 33、cli 9 全过；7 / 30（14+16）/ 0 不变，clauve `git status --porcelain` 前后为空）、`pnpm -r build`、`pnpm lint` 通过，跑完无遗留 serve / mcp / scip-python 进程。独立验证一轮（安全实测：Host/Origin 绕过、路径穿越、token 泄露均未发现问题），7 个问题已修：serve / MCP 退出前结束 scip-python 子进程并删除临时文件，数据目录初始化和快照清理时删除已退出进程留下的 `.scip.<pid>.tmp`；当前快照被清理后自动重建索引，serve 每 5 分钟刷新当前快照的 last_used_at 防止被清理；工作区快照复制时保留符号链接本身；500 只返回 `internal_error`；MCP 断开时等索引任务结束再关库，中断的解析标 failed；reviews 只清理已结束的记录；cli 增加真实 `codeinsight mcp` 的 stdio 端到端测试。取舍：Host 只接受 `127.0.0.1:<端口>` / `localhost:<端口>`，带 Origin 时同样限制（方案外新增，防 DNS rebinding）；搜索在"完全相同 > 前缀 > 子串"每一档内正式代码在测试代码前；当前快照未就绪返回 503 `index_not_ready`，已清理返回 410 `snapshot_gone`；建索引任务只在内存记录 running/done/failed；`POST /api/reviews` 不支持 intentFile；callers/callees 返回扁平 nodes + edges，depth 最大 5；静态文件目录为 packages/cli/web/，没有构建产物时显示占位页；MCP `review_changes` 复用 reportToMarkdown，不写 reviews 表；名字对应多个符号时返回候选；建索引超时 300s 返回错误说明，任务在后台继续。已知：仓库内指向仓库外的 `.py` 符号链接，提取和 scip-python 会读取目标内容入索引（源码接口不返回目标原文）。改动 packages/server/、packages/cli/src/commands/{serve,mcp}.ts，以及 core 的 store/{db,data-dir}.ts、scip/runner.ts、snapshot/build.ts、similar/index.ts

- [x] 阶段6：Web UI
  - 涉及模块：packages/web、packages/cli（`review --format html` / `--open`，以及打包时把 web 构建产物复制进 cli 的发布目录；cli 对 web 声明 workspace 依赖，`pnpm -r build` 按依赖顺序先构建 web）
  - 依赖：阶段5
  - 内容：Vite + React；页面：发起审查（工作区 / 提交区间、意图文本）、进度、改动清单（按模块分组，显示 change 类型、入口标签、正式/测试调用方数）、结构图（改动函数 + 1–2 层邻居，React Flow + ELK，新增边绿色、删除边红色虚线）、影响面面板、重复实现面板、意图偏离面板、warnings；浏览视图（4.4 节浏览流程：建索引进度、入口列表、符号搜索、邻居图逐层展开与折叠、面包屑、测试代码显示切换、源码面板里可点击的调用）；源码查看（点击时检查 JS 桥，有则调 `openFile`，否则调 `/api/source`；removed 函数一律用 `/api/source`）；410 `snapshot_gone` 的处理；构建产物由 server 托管；HTML 报告：用同一套报告视图构建一个单文件版本（报告 JSON 内嵌，不需要 serve），供 CLI `review --format html` 输出，`review --open` 生成 HTML 后用系统浏览器打开
  - 完成标准：`pnpm --filter @codeinsight/web build` 和组件测试通过；Playwright 测试在 fixtures 仓库上启动 serve，自动检查：发起工作区审查后出现改动清单、搜索一个函数后邻居图有预期的调用方、展开一层后节点数增加、无 JS 桥时点击函数显示源码面板；`codeinsight review --repo <fixtures 仓库> --format html --out /tmp/r.html` 生成的文件离线打开能看到改动清单；手工检查：`git clone ~/project/Clauve /tmp/clauve-80cf8e1 && git -C /tmp/clauve-80cf8e1 checkout 80cf8e1`，再 `codeinsight serve --repo /tmp/clauve-80cf8e1 --data-dir /tmp/ci-web --open` 后在浏览器中：对 fc4c752 发起审查能看到审查的全部面板；入口列表里能看到 FastAPI 接口；搜索 `insert_audit_log` 后选 `server/modules/lease/repository.py` 那一份，邻居图左侧有 7 个调用方，展开其中一个能再加载一层；源码面板里点击一个调用能跳到被调用函数的邻居图
  - 验证：`pnpm -r build`（core → web → cli，cli 构建时复制 web 产物到 packages/cli/web/）、`pnpm lint`、`pnpm -r test`（core 121+2 跳过、server 33、cli 12+1 跳过、web 组件 15）通过；`CODEINSIGHT_CLAUVE=~/project/Clauve pnpm --filter @codeinsight/web test:e2e` 通过：fixtures 上工作区审查出现改动清单、搜索后邻居图有预期调用方、展开一层节点数增加、无 JS 桥时显示源码面板、token 不出现在 URL / document.cookie / localStorage；`review --format html --out` 生成的报告以 file:// 离线打开（拦截所有网络请求）能看到改动清单，意图文本里的 `</script>` 按原文显示；clauve 检查（/tmp/clauve-80cf8e1、`--data-dir /tmp/ci-web`）入口列表 151 个 FastAPI 入口、lease 版 `insert_audit_log` 邻居图 7 个调用方、展开一层节点 9→11、源码面板点击调用跳到被调用函数、fc4c752 审查各面板都显示，截图在 /tmp/ci-web-shots/；clauve `git status --porcelain` 前后为空。取舍：结构图只画 1 层邻居（改动函数、topProd 调用方、边变化另一端，最多 60 个改动函数），离线 HTML 报告不调接口也能画；离线报告不含源码，有 JS 桥交给 IDE，否则只提示文件位置；单击设为中心、双击打开源码；`review --open` 隐含 html，不给 `--out` 时写到系统临时目录；HTML 报告带 CSP `default-src 'none'`，约 1.9MB（含 ELK）；Playwright 不在 `pnpm -r test` 里，单独 `test:e2e`。待定：JS 桥 `reviewWorking()` 页面如何响应留到阶段 7；4.4 第 6 条的重复实现误报阈值还没调，待负责人看过界面后决定。改动 packages/web/、packages/cli/src/{commands/review.ts,commands/serve.ts,commands/html-report.ts,open-browser.ts,web-assets.ts}、packages/cli/scripts/copy-web.mjs、packages/core/src/report/types.ts

- [!] 阶段7：JetBrains 插件
  - 涉及模块：plugins/jetbrains
  - 依赖：阶段6
  - 内容：IntelliJ Platform Gradle Plugin 2.x，JDK 21 构建，最低 2025.1（`sinceBuild = 251`），只依赖 `com.intellij.modules.platform`；`pluginVerification { ides { recommended() } }`；设置页（Node 路径、codeinsight 路径、数据目录）；工具窗口：用 `EnvironmentUtil` 的环境查找 Node 并启动和结束 serve 进程、JCEF 加载 Web UI、`onLoadEnd` 时用 `JBCefJSQuery` 注入 JS 桥（`openFile`、`reviewWorking`）、JCEF 不可用时改为外部浏览器打开；`.codeinsight` 排除目录通知；"审查未提交改动"动作；找不到 Node 或 codeinsight 时显示安装指引
  - 完成标准：`./gradlew buildPlugin verifyPlugin` 通过（首次运行会下载被校验的 IDE，需要联网）；单测覆盖 serve 输出解析、Node 查找顺序；手工在 PyCharm 和 IntelliJ IDEA 里（用不需要付费许可的版本）打开小 Python 项目，改动后点"审查未提交改动"能看到报告，点击函数在编辑器中跳到对应行，首次启动时出现"将 .codeinsight 标记为排除目录"通知，点击后该目录变为排除目录且查找用法不再出现快照里的重复结果，从 Dock 启动 IDE 时也能找到 nvm / Homebrew 安装的 Node，关闭项目后 serve 进程退出
  - 阻塞：构建需要 JDK 21，本机只有 OpenJDK 11（/Users/pudongkai/Library/Java/JavaVirtualMachines/ms-11.0.32.1）。需要负责人决定是否安装 JDK 21（以及用哪个发行版、怎么装），首次 `./gradlew buildPlugin verifyPlugin` 还会联网下载 Gradle 和被校验的 IDE；手工检查需要在 PyCharm 和 IntelliJ IDEA 里装插件操作

## 9. 待确认问题

无。已确认（2026-11-11）：
- 开源许可证：MIT
- 项目名和 npm 包名：`codeinsight`（2026-11-11 查询 npm 上未被占用）。monorepo 内部包用 `@codeinsight/*`，设为 `private`，不发布；对外只发布 `codeinsight` 一个包
- 插件不打包 Node，用户自行安装 Node ≥ 22.13；存储用 Node 内置的 `node:sqlite`，不用 `better-sqlite3`
- 数据目录默认放在仓库内的 `.codeinsight/`，需要被 git、IDE、pyright 排除（做法见 4.1）
- 插件最低支持 IDE 2025.1
