# CodeInsight P0–P2 技术方案：Python 结构化审查、CLI/MCP 与 JetBrains 插件

开发状态: TODO
方案评审: 待评审
需求来源: 2026-11-11 头脑风暴对话，以及在 clauve、bluewhale 上的验证结论
作者: steve@data-coding.com　　日期: 2026-11-11

## 1. 背景与目标

AI 写代码的速度远超人审代码的速度。在纯 AI 写的项目 clauve 上统计：10% 的提交改动 19 个以上文件，最大一次 98 个文件、7329 行。逐行读 diff 已经审不过来，而且容易漏掉这几类问题：

- **提交说明和实际改动不一致**：抽查 4 个大提交，3 个漏写了整块功能（如 fc4c752 说明里没提新增的"组织/团队/成员管理"，16 个函数 + 9 个模板）。
- **重复实现**：同一功能被重新写一遍，并开始各自演变（如 `insert_lease` 两份，其中一份已没人调用，参数类型也没跟上）。
- **改了调用方很多的函数却没意识到影响面**。

CodeInsight 是一个开源的本地工具，把审查从"逐行看 diff"变成"看结构上改了什么"。本方案覆盖 P0–P2，做完后要达到：

1. `codeinsight review` 能对一个 Python 项目的提交区间或未提交改动，输出按模块分组的函数级改动清单，每个改动函数附带正式代码和测试代码的调用方数量。
2. 在 clauve 上，`insert_audit_log` 的调用方是 6 个、`select_release_by_version` 是 30 个，与验证时 scip-python 的结果一致。正式代码到测试代码的调用边为 0。
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
- JetBrains 插件（PyCharm 社区版和 IDEA 都能用）：工具窗口嵌入 Web UI，点击跳转源码，一键审查未提交改动

**本次不做：**
- Java、TS 的提取和解析，以及 IDE PSI 导出（P3、P4）。不支持的语言文件在报告里按文件级 diff 列出，并标注"暂不支持结构分析"
- 全局代码地图（整个项目可缩放浏览）、模块聚类、LLM 模块摘要、从入口出发的时序图式调用链视图（P3）。P0–P2 的浏览视图只做以单个函数为中心的邻居图
- "新增但没人调用的代码"、架构分层规则、吞异常等可疑模式检查（验证中误报多或价值低）
- 名字匹配的兜底解析器。scip-python 失败时，报告给出提示，调用关系部分为空，不做降级匹配
- 增量索引；读取 AI agent 会话记录作为意图来源；PR 平台集成；VS Code 插件
- 把 Node 运行时打包进插件（见待确认问题 3）

## 3. 现状分析

新项目，仓库为空。设计依据来自 2026-11-11 的验证（验证脚本已删除，结论如下）：

**codegraph 不适合作为解析层**
- 节点 id 由"路径 + 类型 + 名字 + 行号"生成，函数位置一变，id 就变。旧版本文件 55 个函数只有 39 个 id 能对上，按"文件 + 类型 + 限定名"匹配能对上 55 个。
- 在 clauve 的 Python 部分，codegraph 约 17% 的调用对是错的（911/5229），主要是同名乱连：正式代码的 `conn.execute` 被连到测试文件里的 `execute`。同时漏掉约 900 对 `repo.f()` 这类别名模块调用。
- 框架只在项目根目录检测，clauve 的 FastAPI 接口全部没被识别成入口。

**scip-python 可以作为 Python 解析层**
- 许可证：scip-python MIT，scip.proto Apache-2.0。
- clauve Python 部分（176 个文件、约 3.6 万行）全量索引 9–11s，内存约 1GB，输出约 7.5MB。没有增量索引。
- 不装 Python 依赖时，项目内调用关系与装依赖时完全一样，用户不需要准备 venv。
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
| `better-sqlite3` | 存储 | MIT |
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
- **不改用户仓库**。所有数据写在数据目录（默认 `<repo>/.codeinsight/`，目录里自带一个内容为 `*` 的 `.gitignore`），base 版本用 `git archive` 导出，不建 worktree，不切分支。可以用 `--data-dir` 指到仓库外。
- **LLM 可选**。只有意图偏离检测需要 LLM，不配置时其他功能都能用。

仓库结构：

```
codeinsight/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  LICENSE
  packages/
    core/     src/{model,store,git,classify,config,extract,resolve,scip,review,similar,intent,llm,report}
    cli/      src/commands/*
    server/   src/{http,mcp}
    web/      Vite + React
  plugins/jetbrains/   Gradle + Kotlin
  docs/design/
```

运行要求：Node ≥ 20。scip-python 作为 core 的 npm 依赖安装，通过子进程调用。

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
| created_at | 用于清理，只保留最近 8 个快照 |

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
| signature | Python 留空字符串；Java 填参数类型列表，用于区分重载 |
| parent_id | 所属类或外层函数 |
| start_line, end_line | 只用于定位和展示，含装饰器行 |
| body_hash | 函数体原文的 hash，判断"是否修改过" |
| norm_tokens | 归一化后的 token 序列（压缩存储），供相似度计算 |
| docstring | 截断到 500 字符 |
| is_test, is_generated | 继承所在文件，类级生成代码（如 Lombok）将来单独标 |

同一快照里 `symbol_key` 重复时（同名函数被重复定义），按出现顺序给 qualified_name 加 `#2`、`#3` 后缀。

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

**缓存目录**

```
<dataDir>/
  .gitignore            内容为 *
  index.db
  snapshots/<sha>/      git archive 导出的 base 源码，用完保留，随快照清理
  scip/<content_key>.scip
  llm-cache/<hash>.json
```

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
codeinsight index   [--repo .] [--data-dir DIR]
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
| `GET /api/status` | 仓库、Node 版本、LLM 是否配置、最近的报告 |
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

**MCP 工具**（不重复 codegraph 已有的"查代码"能力，只做审查相关的）

| 工具 | 入参 | 输出 |
| --- | --- | --- |
| `review_changes` | `base?`, `head?`, `working?`, `intent?` | 精简 Markdown：按模块的改动清单、调用方多的改动、重复候选、意图偏离、警告 |
| `get_impact` | `symbol`（名字或 key）, `depth?` | 正式代码和测试代码调用方，按层列出 |
| `find_similar` | `symbol` 或 `code`（一段尚未写入的代码） | 相似的已有函数及位置，供 AI 写代码前查重 |

**插件与 Web UI 的 JS 桥**：插件在页面里注入 `window.codeinsightHost = { openFile(path, line), reviewWorking() }`。Web UI 检测到它时，点击函数调用 `openFile`；没有时调用 `/api/source` 在页面里显示源码。

### 4.4 关键流程

**review 流程**

1. **确定版本和改动文件**：解析 base、head 为 sha。`git diff --name-status -M base head`（或对比工作区，包含未跟踪文件）得到改动文件，按语言分出 `full` / `structure` / `none`。
2. **准备快照**：
   - base 是提交：`git archive <sha> | tar -x -C <dataDir>/snapshots/<sha>`，已存在就复用。
   - head 是提交：同上。head 是工作区：直接读工作区。
3. **提取**：对两个版本的改动文件（只限支持的语言）做 tree-sitter 提取，得到符号列表。两边的改动文件之外的符号不在此步提取。
4. **解析**（两个版本可并行）：对每个快照，`scip/<content_key>.scip` 已有就复用，否则运行 scip-python（`--cwd <快照根目录> --output <dataDir>/scip/<key>.scip`，超时默认 300s）。成功后对整个快照做提取 + SCIP 转换，写入 symbols、edges、entries。失败时标 `resolver_status=failed`，报告加 warning，跳过第 6 步的调用方统计。
5. **函数级 diff**：按 `symbol_key` 匹配两个版本的符号：
   - 只在 head：`added`；只在 base：`removed`
   - 两边都有、body_hash 不同：`modified`
   - qualified_name 相同、signature 不同：`signature_changed`（Python 下签名为空，不会出现，给 Java 预留）
   - 一个 `removed` 和一个 `added` 的 kind、name 相同且 body_hash 相同或相似度 ≥ 0.9：合并成 `moved`
6. **调用边变化和影响面**：
   - 边变化：对改动符号，比较两个版本出边的目标 `symbol_key` 集合。
   - 调用方：`added`、`modified`、`moved` 在 head 图上查，`removed` 在 base 图上查。按调用方是否为测试代码分开计数，正式代码调用方按数量列出前 5 个。
   - 影响面：沿 `call` 和 `reference` 边向上 BFS 默认 2 层。
7. **模块分组**：模块 = 文件所在目录，取前 `moduleDepth` 层（默认 3，可在配置里改）。
8. **重复实现**：对 `added` 和 `moved` 的非测试函数，调用 similar 模块，见下文。
9. **意图偏离**（配置了 LLM 且未加 `--no-llm`）：调用 intent 模块，见下文。
10. **组装报告**：不支持的语言文件只出现在 `files` 里，并加 `language_unsupported` warning。

**SCIP → 边**

1. 读 index.scip 的 documents。对每个 document，收集带 `enclosing_range` 的定义 occurrence，按文件建立范围区间表。
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

1. 打开工具窗口时，按设置里的 Node 路径（默认从 PATH 查找）启动 `codeinsight serve --repo <项目根目录>`，读取 stdout 第一行拿到端口和 token。找不到 Node ≥ 20 或 codeinsight 时，在工具窗口显示安装指引。
2. JCEF 加载 `http://127.0.0.1:<port>/?token=...`，注入 JS 桥。
3. "审查未提交改动"按钮：调用 `POST /api/reviews {working:true}`，页面轮询进度。
4. 点击函数：JS 桥 `openFile(path, line)` → `FileEditorManager` 打开文件并跳转到行。
5. 项目关闭或 IDE 退出时结束 serve 进程。

### 4.5 公共逻辑

| 公共逻辑 | 位置 | 负责实现的阶段 |
| --- | --- | --- |
| `symbol_key` 生成与解析、id 计算 | `packages/core/src/model/symbol-key.ts` | 阶段1 |
| 测试代码和生成代码判断（`tests/`、`test_*.py`、`*_test.py`、`conftest.py`，可在配置中追加 glob） | `packages/core/src/classify/` | 阶段1 |
| git 操作：解析 ref、改动文件列表、`git archive` 导出、工作区内容 hash | `packages/core/src/git/` | 阶段1 |
| 配置读取（`codeinsight.config.json` + 环境变量 + 数据目录） | `packages/core/src/config/` | 阶段1 |
| 语言识别与 support_level | `packages/core/src/model/language.ts` | 阶段1 |
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
- 发布：core/cli/server 打包成一个 npm 包 `codeinsight` 发布，Web UI 构建产物打进这个包；插件发布到 JetBrains Marketplace，最低支持 2024.2，只依赖 `com.intellij.modules.platform`。

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
| `better-sqlite3` 是原生模块 | 少数平台没有预编译包时安装失败 | 依赖它的预编译包覆盖 macOS / Linux / Windows 主流架构；不行再换 `node:sqlite` |

## 7. 测试方案

**单元测试（vitest，每个阶段跟着写）**
- symbol_key、classify、git 辅助函数
- 提取层：用 `packages/core/test/fixtures/py-basic/` 下的小样例覆盖类、方法、嵌套函数、装饰器、重复定义、各框架入口
- SCIP 转换：用 fixtures 跑真实的 scip-python，检查别名导入（`from . import repo as r; r.f()`）能连上、调用和引用能区分、外部符号被丢弃
- 函数级 diff：用测试里临时 `git init` 的仓库，构造新增、删除、修改、搬家
- similar：构造重复、透传包装、只有 SQL 不同的样板代码三种情况
- intent：用假的 LLM 客户端返回固定 JSON，检查解析、key 过滤、缓存

**集成测试（需要本机有 clauve，环境变量 `CODEINSIGHT_CLAUVE=/Users/dongkaipu/projects/clauve`，没有时跳过）**
- 全部使用 `--data-dir` 指到临时目录，不在 clauve 里写任何文件；测试结束检查 `git -C $CODEINSIGHT_CLAUVE status --porcelain` 输出与测试前一致
- 当前 HEAD 索引：`insert_audit_log`（server/modules/lease/repository.py）调用方 6 个，`select_release_by_version` 调用方 30 个，正式代码指向测试代码的边为 0
- `review --base fc4c752~1 --head fc4c752`：`console/modules/console/admin_api.py` 下出现 16 个 `added` 函数；改动中的非 Python 文件出现在 `files` 并带 `language_unsupported` warning
- `similar --all`：结果包含 `select_org_by_id`、`_ensure_same_org`、`select_user_org_id`、`insert_lease` 四组

**手工验证**
- 不装 IDE，用 `codeinsight serve --open` 在浏览器里浏览 clauve：入口列表、搜索、邻居图展开、源码面板跳转
- 在 PyCharm 社区版和 IDEA 里各装一次插件，打开一个小 Python 项目，改几个函数后点"审查未提交改动"，检查面板内容和点击跳转

## 8. 开发计划

- [ ] 阶段1：项目骨架、数据模型与公共基础
  - 涉及模块：根目录配置、packages/core/src/{model,store,classify,git,config}
  - 依赖：无
  - 验证方式：独立
  - 内容：pnpm monorepo（core、cli、server、web 四个包，TS 严格模式，vitest，eslint）；LICENSE；4.2 节全部表结构和 schema 版本检查；symbol_key、语言识别、classify、git 辅助函数、配置读取、数据目录初始化（含 `.gitignore`）和快照清理
  - 完成标准：`pnpm install && pnpm -r build && pnpm -r test` 通过；store 测试覆盖建表、写入读取四类实体、schema 版本不一致时重建；git 测试在临时仓库里覆盖提交区间、工作区（含未跟踪文件）、`git archive` 导出

- [ ] 阶段2：Python 提取层与 scip-python 解析
  - 涉及模块：packages/core/src/{extract,resolve,scip}、packages/core/test/fixtures/、packages/cli/src/commands/index.ts
  - 依赖：阶段1
  - 验证方式：独立
  - 内容：web-tree-sitter 加载 Python 语法；提取类、函数、方法、嵌套函数、docstring、body_hash、norm_tokens；入口识别（4.4 节表格）；token 归一化；解析器接口 `Resolver` 与 `ScipPythonResolver`（运行 scip-python、读取 index.scip、按 4.4 节转换成边）；`codeinsight index` 命令
  - 完成标准：`pnpm --filter @codeinsight/core test` 通过，fixtures 覆盖别名导入、调用与引用区分、外部符号丢弃、各框架入口；设置 `CODEINSIGHT_CLAUVE` 后集成测试通过：`insert_audit_log` 调用方 6、`select_release_by_version` 调用方 30、正式代码到测试代码的边为 0，且 clauve 的 `git status --porcelain` 不变

- [ ] 阶段3：结构化 diff、影响面与审查报告
  - 涉及模块：packages/core/src/{review,report,graph}、packages/cli/src/commands/review.ts
  - 依赖：阶段2
  - 验证方式：独立
  - 内容：4.4 节 review 流程第 1–7、10 步（快照准备、两个版本并行解析、函数级 diff 含 moved、调用边变化、调用方和影响面、模块分组、不支持语言的文件级列出）；图遍历公共逻辑（调用方和被调用方两个方向）；`ReviewReport` 类型；Markdown 和 JSON 输出；`codeinsight review` 命令（`--format json|md`）
  - 完成标准：单测在临时仓库里覆盖 added / removed / modified / moved、解析失败时仍输出提取结果和 warning；集成测试 `review --base fc4c752~1 --head fc4c752 --format json` 中 admin_api.py 有 16 个 `added` 函数，非 Python 文件带 `language_unsupported`；同一 base 第二次审查时不再运行 scip-python（日志里能看到缓存命中）

- [ ] 阶段4：重复实现与意图偏离
  - 涉及模块：packages/core/src/{similar,intent,llm}、packages/cli/src/commands/similar.ts
  - 依赖：阶段3
  - 内容：similar 模块（候选、MinHash/LSH、评分、排除规则）并接入 review 第 8 步；`codeinsight similar` 命令；LLM 客户端（anthropic、openai-compatible，配置、缓存、首次提示）；intent 模块并接入 review 第 9 步；`--intent`、`--intent-file`、`--no-llm`
  - 完成标准：单测覆盖重复、透传包装、SQL 样板三种情况，以及 intent 的假 LLM 解析、非法 key 过滤、缓存命中；集成测试 `similar --all` 包含 `select_org_by_id`、`_ensure_same_org`、`select_user_org_id`、`insert_lease`；未配置 LLM 时 review 正常完成并带 `llm_not_configured` warning

- [ ] 阶段5：本地 HTTP 服务与 MCP
  - 涉及模块：packages/server/src/{http,mcp}、packages/cli/src/commands/{serve,mcp}.ts
  - 依赖：阶段4
  - 验证方式：独立
  - 内容：4.3 节 HTTP API（只监听 127.0.0.1、随机端口、token 校验、异步审查任务与进度、异步建索引与进度、源码片段、调用方和被调用方树、符号详情、符号搜索、入口列表、相似候选、静态文件托管）；启动时 stdout 输出端口、token、url，`--open` 打开浏览器；启动时没有可复用快照就在后台建索引；MCP 三个工具 `review_changes`、`get_impact`、`find_similar`（`find_similar` 支持传一段代码）
  - 完成标准：server 测试覆盖：无 token 或错误 token 返回 401；`/api/source` 拒绝仓库外路径（如 `../`）；审查任务和建索引任务都能从 running 到 done；在 fixtures 仓库上搜索能按"名字完全相同 > 前缀 > 子串、测试代码在后"排序，`callers` / `callees` 返回结果与 edges 表一致；MCP 测试用 SDK 客户端走 stdio 调用三个工具都返回非空结果

- [ ] 阶段6：Web UI
  - 涉及模块：packages/web
  - 依赖：阶段5
  - 内容：Vite + React；页面：发起审查（工作区 / 提交区间、意图文本）、进度、改动清单（按模块分组，显示 change 类型、入口标签、正式/测试调用方数）、结构图（改动函数 + 1–2 层邻居，React Flow + ELK，新增边绿色、删除边红色虚线）、影响面面板、重复实现面板、意图偏离面板、warnings；浏览视图（4.4 节浏览流程：建索引进度、入口列表、符号搜索、邻居图逐层展开与折叠、面包屑、测试代码显示切换、源码面板里可点击的调用）；源码查看（有 JS 桥时调 `openFile`，否则调 `/api/source`）；构建产物由 server 托管
  - 完成标准：`pnpm --filter @codeinsight/web build` 和组件测试通过；`codeinsight serve --repo <clauve> --data-dir /tmp/ci-web --open` 后在浏览器中：对 fc4c752 发起审查能看到审查的全部面板；入口列表里能看到 FastAPI 接口；搜索 `insert_audit_log` 后邻居图左侧有 6 个调用方，展开其中一个能再加载一层；源码面板里点击一个调用能跳到被调用函数的邻居图

- [ ] 阶段7：JetBrains 插件
  - 涉及模块：plugins/jetbrains
  - 依赖：阶段6
  - 内容：IntelliJ Platform Gradle Plugin 2.x，最低 2024.2，只依赖 `com.intellij.modules.platform`；设置页（Node 路径、codeinsight 路径、数据目录）；工具窗口：启动和结束 serve 进程、JCEF 加载 Web UI、注入 JS 桥（`openFile`、`reviewWorking`）；"审查未提交改动"动作；找不到 Node 或 codeinsight 时显示安装指引
  - 完成标准：`./gradlew buildPlugin verifyPlugin` 通过；手工在 PyCharm 社区版和 IDEA 里打开小 Python 项目，改动后点"审查未提交改动"能看到报告，点击函数在编辑器中跳到对应行，关闭项目后 serve 进程退出

## 9. 待确认问题

无。已确认（2026-11-11）：
- 开源许可证：MIT
- 项目名和 npm 包名：`codeinsight`（2026-11-11 查询 npm 上未被占用）。monorepo 内部包用 `@codeinsight/*`，设为 `private`，不发布；对外只发布 `codeinsight` 一个包
- 插件不打包 Node，用户自行安装 Node ≥ 20
