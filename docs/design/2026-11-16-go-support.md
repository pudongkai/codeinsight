# CodeInsight Go 语言支持技术方案

开发状态: RUNNING
方案评审: 通过（2026-11-16）
需求来源: 2026-11-16 用户需求：“增加 go 语言支持”。已确认：调用关系用 scip-go，scip-go 或 Go 工具链不可用、运行失败时按名称匹配；第一版覆盖符号和调用关系、入口识别、数据模型和外部依赖、相似代码和测试文件识别
作者: dongkai@zbyte-inc.com　　日期: 2026-11-16

## 1. 背景与目标

现在只有 Python 是完整支持（`LANG_SUPPORT` 只有 `python: 'full'`），其他语言的文件只在审查里显示为“文件级变更”。Go 项目打开后看不到函数、调用图、入口和概览。

做完后要达到：

1. `.go` 文件的支持级别为 `full`（`vendor/`、`testdata/` 下的除外）。快照里有 Go 的 module（每个文件一个）、function、method（带接收者的方法和 interface 里声明的方法）、struct（kind=`class`）、interface（kind=`interface`）符号，名字、签名、行号、文档注释、body hash、规范化 token 都有值。
2. 有 scip-go 且能加载项目时，Go 的调用边、引用边、import 边来自 scip-go（`provenance=scip`）。scip-go 找不到、运行失败或超时时，改用名称匹配得到调用边和 import 边（`provenance=name_match`），快照的 `resolver_status` 仍为 `ok`；快照记下“Go 的边来自名称匹配”和原因，之后 scip-go 可用时会重新解析，不会一直沿用名称匹配的结果。
3. 同一个仓库里 Python 和 Go 都有时，各自解析，边合并入库；Python 部分的行为和现在一致（已有测试不改期望值）。
4. 入口识别：`package main` 里的 `func main`（cli）、net/http、gin、echo、chi 的路由注册（http，含路由分组的路径前缀）、cobra 命令（cli）。处理函数支持函数名、`pkg.Func`、方法值 `h.Create`、函数字面量。
5. 数据模型：带 `gorm` 标签或嵌入 `gorm.Model` 的 struct 为 `gorm`，带 `db` 标签的为 `sqlx`，只带 `json` 标签的为 `json`。网页里显示对应标签。
6. 概览：Go 的第三方依赖按 import 路径分类，标准库和项目内包（按 `go.mod` 的 module 路径判断）不算外部依赖；`os.Getenv` / `os.LookupEnv` 的字面量参数列为环境变量；Go 符号按首字母大写判断是否公开。
7. 相似代码能比较 Go 函数（只和 Go 比），签名形状按 Go 的参数和返回值算，接收者不算参数；同名方法（如各类型的 `String()`）不算“同名重复”；MCP 的 `similar` 工具可以传 `language: "go"`。
8. `*_test.go` 识别为测试文件；`*.pb.go`、`*.pb.gw.go`、`*_gen.go`、文件开头有 `// Code generated ... DO NOT EDIT.` 的识别为生成代码。

## 2. 范围

**本次要做：**
- core：按语言分派的提取接口，Python 改成通过这个接口调用（行为不变）
- core：Go 提取器（tree-sitter-go）、Go 的调用点和局部类型收集、Go 入口和数据模型识别
- core：按语言拆分的组合解析器；scip-go 解析器；Go 名称匹配解析器；快照记录各语言边的来源，scip-go 可用后重新解析
- core：SCIP 边转换里的 Python 假设（注释符号、续行、模块定义、路径前缀）改为按语言处理
- core：分类、相似代码、概览外部依赖和环境变量、公开符号判断、敏感文件列表加上 Go
- core：外部命令查找和进程组结束抽成通用函数（CLI 模型服务和 scip-go 共用）
- server：MCP `similar` 工具的 `language` 参数
- web：数据模型标签加 `gorm`、`sqlx`、`json`；状态栏在 Go 调用关系来自名称匹配时给出提示

**本次不做：**
- 自动安装 scip-go（只查找，找不到就用名称匹配）
- 接口实现关系（`implement` 边）、接口方法调用分派到具体实现（`dispatch` 边）
- 泛型类型参数的单独建模（泛型函数按普通函数处理，类型参数写进签名文字）
- `const` / `var` / 类型别名作为符号
- 名称匹配路径的 `reference` 边（只生成 `call` 和 `import`）
- 其他 Go Web 框架（fiber、beego 等）、其他 ORM（ent、xorm 等）
- 网页的语言筛选和图标

## 3. 现状分析

- **语言判断**：`packages/core/src/model/language.ts` 的 `Language` 已经有 `'go'`，`EXT_LANG` 已把 `.go` 映射到 `go`，`LANG_SUPPORT` 只有 `python: 'full'`。
- **提取**：`packages/core/src/extract/` 没有按语言分的接口。`parser.ts` 的 `getPythonParser` 加载 `tree-sitter-python.wasm`；`python.ts` 的 `extractPythonFile` 是唯一的提取器，`restoreExtractedFile` 从库里的符号还原名字位置；`index.ts` 的 `extractPythonFiles` / `resolveCrossFile` 对所有文件跑 Django 路由和 `resolveModels`。数据结构见 `extract/types.ts`。`extract/cache.ts:12` 的 `FINGERPRINT_EXTRA_MODULES` 列出提取代码引用的 extract 目录外模块，`:18` `GRAMMAR_PACKAGES` 只有 tree-sitter-python。
- **快照**：
  - `snapshot/incremental.ts:162` 只有 `language === 'python'` 的文件进入提取输入；`:33` `PROJECT_CONFIG_FILES` 只有 Python 配置；`isPlaced`（`:36`）决定工作区快照目录里放哪些文件；没变的文件硬链接到上一个快照目录（`linkFromPrevious`，`:93-99`），所以快照目录里的文件不能被外部工具改写；`sameResolverInput`（`:273-291`）只比较文件。
  - `snapshot/build.ts`：`reusable`（`:66`）在 `resolver_status` 为 `ok`/`skipped` 时整体复用快照；`resolverOf`（`:117`）是唯一 `new ScipPythonResolver()` 的地方（`review/versions.ts:23`、`server/src/workspace.ts:11` 只是注释里提到）；`tryReuseEdges` 用 `edgesCodeHash(resolver)` 判断能否复制上一个快照的边；`restoreExtracted`（`:198`）用 Python 解析器还原所有 `full` 文件，重试解析时走这条路；`extract_done` 日志字段名为 `python`。
  - `store/data-dir.ts:357` 清理快照时只删 `scipPath`（`<contentKey>.scip`）。
  - 表结构加列的做法见 `store/schema.ts:95`（先检查列是否存在再 `ALTER TABLE ADD COLUMN`）。
- **解析**：`resolve/types.ts` 的 `Resolver`（`version` 是同步属性）；`resolve/scip-python.ts` 的 `ScipPythonResolver`；`scip/runner.ts` 的 `runProcess` 写死 `spawn(process.execPath, ...)`、没有建进程组；`resolve/scip-edges.ts` 的 `scipToEdges(index, files, sources, snapshotId)` 有 Python 假设：`isModuleDefinition`（`:73`，以 `/__init__:` 结尾）、`isCallAt` 把 `#` 当注释（`:107`）、续行用 `python-lines.ts` 的 `continuedLines`。解析失败时没有后备，快照标 `resolver_status=failed`，下次只重跑解析。
- **依赖边的使用方**：概览的模块划分和模块间依赖用 `import`/`reference` 边（`overview/partition.ts:163-168`、`overview/facts.ts:57,115`）。
- **其他 Python 专用逻辑**：`classify/index.ts`（测试和生成代码规则）；`similar/features.ts:94` `signatureShape`、`:135-141` 同名重复规则；`similar/index.ts:245` 片段路径 `<snippet>/snippet.py`（语言由路径判断，`features.ts:148`）；`overview/external.ts`、`overview/external-table.ts`；`overview/facts.ts:203` `isPublic`（`_` 前缀，方法只看父节点是 class）；`ask/sensitive.ts:14`；`web/src/app/StatusBar.tsx:81` 只在 `resolverStatus !== 'ok'` 时提示。
- **忽略规则**：文件清单只按 `.gitignore` 过滤（`git/index.ts:120-122`），没有 vendor 规则。
- **测试**：`packages/core/test/*.test.ts`，fixture 在 `packages/core/test/fixtures/py-basic`、`py-shop`。各包 `pnpm --filter <包名> test`（vitest）。
- **依赖**：`tree-sitter-go@0.25.0` 的 npm 包根目录自带 `tree-sitter-go.wasm`，和 `tree-sitter-python@0.25.0` 同样的方式加载。本机有 go 1.27.1，没有 scip-go。

### 可复用的已有代码

| 功能 | 已有实现（文件:类/方法） | 用在哪些阶段 |
| --- | --- | --- |
| wasm 语法加载、解析器缓存 | `extract/parser.ts:getPythonParser` | 阶段1、3 |
| token 规范化、shingle | `extract/normalize.ts:normalizeTokens`、`shingles` | 阶段3 |
| symbol_key 生成、去重后缀 | `model/symbol-key.ts:makeSymbolKey`；`extract/python.ts` 的去重逻辑 | 阶段3 |
| 提取结果缓存 | `extract/cache.ts` | 阶段1、3 |
| SCIP 读取 | `scip/reader.ts` | 阶段0、4 |
| SCIP 定义/引用转边 | `resolve/scip-edges.ts:scipToEdges` | 阶段2、4 |
| 子进程超时、中止、登记 | `scip/runner.ts:runProcess`、`killActiveScipProcesses` | 阶段2、4 |
| 进程组启动和结束的写法 | `llm/cli/process.ts`（`detached` + `process.kill(-pid)`，`:164`、`:267`），参照它改 `scip/runner.ts`，不改这个文件 | 阶段2 |
| 命令查找（PATH 和常见安装目录） | `llm/cli/command.ts:commonCliDirs`、`resolveCliCommand` | 阶段2 |
| 跨文件路由处理函数查找 | `extract/index.ts:resolveCrossFile` 里的 Django 路由解析 | 阶段5 |
| 库分类、外部依赖汇总 | `overview/external.ts`、`overview/external-table.ts` | 阶段6 |
| 相似度计算 | `similar/index.ts`、`similar/features.ts` | 阶段6 |
| 表加列 | `store/schema.ts` 的加列写法 | 阶段2 |

## 4. 方案设计

### 4.1 整体思路

提取层加一个按语言注册的 `LanguageSupport`，快照、相似代码、概览都通过它取解析器和提取函数，不再直接调用 Python 的函数。Python 现有代码包一层注册进去，行为不变。Go 新增一份实现。

解析层加一个 `LanguageResolver`（按语言组合的解析器）：只对快照里实际出现的语言调用对应的子解析器，边合并入库，并记录每种语言的边来自哪里。Go 解析器先试 scip-go，失败时改用名称匹配，自己不抛异常（被中止时除外）。

```
快照构建 ──提取──> LanguageSupport(python | go) ──> ExtractedFile[]（带 language）
         ──解析──> LanguageResolver（只跑出现的语言）
                    ├─ python 文件 → ScipPythonResolver（现有）
                    └─ go 文件     → GoResolver
                                      ├─ scip-go 可用且成功 → scipToEdges(go 规则)       → 来源 scip
                                      └─ 否则 → goNameMatchEdges（提取时收集的调用点和 import）→ 来源 name_match + 原因
```

阶段0 先在本机装好 scip-go，用一个小 Go 项目实际跑一遍，确认符号格式和运行条件后再定 Go 的 SCIP 规则细节。

### 4.2 数据模型

**表结构**：`snapshots` 加一列 `edge_sources TEXT`（JSON，可空），按 `store/schema.ts` 的加列写法。内容如 `{"go":{"source":"name_match","reason":"not_found","at":1763280000000}}`、`{"python":{"source":"scip"},"go":{"source":"scip"}}`。`reason` 取值 `not_found`（找不到 scip-go 或 go）、`failed`（运行失败、超时、加载失败）、`disabled`（选项关闭）。旧快照这一列为空，按“全部来自 scip”处理。

**代码里的类型**：
- `ExtractedFile` 加 `language: Language`；`djangoRoutes` 改为可选；加 Go 专用的可选字段 `go?: GoFileFacts`：
  - `packagePath`（包导入路径）、`packageName`、`imports`（import 名 → 路径，普通对象，不用 Map，提取缓存能直接序列化）、`importRows`
  - `calls: CallSite[]`：`{ callerId, line, col, form: 'ident' | 'pkg' | 'selector', name, qualifier?, receiverType? }`。`foo()` 为 ident；`pkg.Foo()` 且 `pkg` 是 import 名为 pkg（qualifier 为 import 路径）；其他 `x.Foo()` 为 selector，`receiverType` 为按局部类型推断得到的类型（见 4.4），推断不出为空
  - `structTags`（struct 符号 id → 标签里的键、是否嵌入 `gorm.Model`）、`envReads`（`os.Getenv` 等的字面量参数）
  - `routes`、`cobraCommands`（阶段5 加入）
- `restoreFile` 对 Go 重新解析源码，`go` 字段完整还原；还原全部 Go 文件后再跑一遍 Go 跨文件处理里的类型补全部分（构造函数返回类型、跨文件 parentId），不跑入口和模型部分。`goModules` 从快照目录里的 `go.mod` 重新读取。这样重试解析时名称匹配的结果和第一次一致。
- `ModelKind` 加 `'gorm' | 'sqlx' | 'json'`。
- `LANG_SUPPORT` 加 `go: 'full'`；`supportLevelOf(language, path)` 加路径参数，`vendor/`、`testdata/` 目录下的 `.go` 文件为 `none`。所有调用方一起改：`fileRow`、`isPlaced`、`review/assemble.ts:18`、`review/versions.ts:95` 的 `isSupported`。这些文件仍放进快照目录供 scip-go 使用（`isPlaced` 对 Go 的 vendor 放行）。

**Go 符号命名**：

| 符号 | kind | qualifiedName | parentId |
| --- | --- | --- | --- |
| 文件 | module | `<包导入路径>/<文件名>`，如 `example.com/shop/order/service.go` | null |
| 函数 | function | `<包导入路径>.Func` | module 符号 |
| 方法 | method | `<包导入路径>.Type.Method`（值接收者和指针接收者同名） | 同一包里有该类型时为类型符号（跨文件在跨文件处理时补上），否则为 module 符号 |
| struct | class | `<包导入路径>.Type` | module 符号 |
| interface | interface | `<包导入路径>.Type` | module 符号 |
| interface 方法 | method | `<包导入路径>.Type.Method` | interface 符号 |
| 作为路由或 cobra 处理函数的函数字面量（阶段5 加入） | function | `<外层函数 qualifiedName>.func<N>`（N 为外层函数里第几个函数字面量，和 Go 运行时的命名一致） | 外层函数符号 |

- 包导入路径：从文件所在目录向上找最近的 `go.mod`，取 `module` 行加上相对目录；找不到 `go.mod` 时用相对目录。
- 同一包里多个 `init` 函数：沿用现有的去重后缀（`#2`）。
- `signature` 为空（Go 没有重载）；`displaySignature` 为 `func (r *T) Name(a int) (string, error)`（去掉函数体）。
- 文档注释：声明前紧挨着的连续 `//` 行（去掉 `//` 前缀）。
- `bodyHash`：整个声明的文字（含接收者和 struct 标签）。

### 4.3 接口设计

- `extract/languages.ts`：

```ts
interface LanguageSupport {
  language: Language;
  /** 进入 extract cache 指纹的语法包名 */
  grammarPackage: string;
  getParser(): Promise<Parser>;
  extractFile(parser, path, source, flags, ctx: ExtractContext): ExtractedFile;
  /** 从库里的符号还原；Go 会重新收集 go 字段 */
  restoreFile(parser, path, source, rows, ctx: ExtractContext): ExtractedFile;
  /** 重试解析时，还原全部文件后调用：只补解析要用的跨文件信息（Go 的类型补全、parentId） */
  completeForResolve?(files: ExtractedFile[]): void;
  /** 全部文件提取完后的跨文件处理：路由处理函数、数据模型、方法的跨文件 parentId */
  resolveCrossFile(files: ExtractedFile[]): { entries: ExtractedEntry[]; models: number };
}
function languageSupport(lang: Language): LanguageSupport | undefined;
```

`ExtractContext` 目前只有 `goModules`（目录 → module 路径），Python 忽略。

- `Resolver` 接口改动（`resolve/types.ts`）：
  - 加可选 `prepare?(languages: Language[]): Promise<void>`。`buildLocked` 和 `retryResolve` 里只创建一个解析器实例，先 `await prepare(本快照出现的语言)`，再把同一个实例交给 `tryReuseEdges` 和 `runResolver`；`edgesCodeHash` 只接收已经 prepare 过的实例。
  - `ResolveInput` 加 `goTimeoutMs`。
  - `ResolveResult` 加 `sources?: Partial<Record<Language, EdgeSource>>`、`effectiveVersion?: string`（实际生效的版本，如 Go 回退到名称匹配时为 `name-match`）、`failed?: { language: Language; reason: string }[]`（部分语言失败）。
- `resolve/language-resolver.ts`：`class LanguageResolver implements Resolver`。
  - `version`：只拼接本次快照出现的语言对应子解析器的 version；各语言的代码 hash 只覆盖本语言用到的文件（`scipResolverCodeHash` 按语言拆分文件范围），纯 Python 仓库的 version 不受 Go 代码改动影响。
  - `resolve`：按 `file.language` 分组调用。某个子解析器抛异常时，记进 `failed`，其他语言的边照常返回。被中止时整体抛出。
  - `defaultResolver()` 替换 `build.ts:117` 的 `new ScipPythonResolver()`。
- `snapshot/build.ts` 的 `runResolver`：
  - 有 `failed` 时：边照常入库，`resolver_status=failed`，`resolver_error` 写失败语言和原因，不写 `edges_code_hash`；下次重跑解析时所有语言都重跑。
  - 全部成功时：`edges_code_hash` 用 `effectiveVersion` 计算。Go 因为 `not_found` 回退时，有效版本是 `name-match`，可以复用（装上 scip-go 后版本变了，自然不再复用）；因为 `failed` 回退时不写 hash（不复用，见 4.4 的重新解析条件）。
  - `edge_sources` 和边一起写入；`reuseEdges`（`incremental.ts:298-307`）复制边时一起复制 `edge_sources`。
- `resolve/go.ts`：`class GoResolver implements Resolver`，`name='go'`，`version` 为 `scip-go@<版本>` 或 `name-match`，加上 Go 解析代码的 hash。构造参数 `{ scip?: boolean }`，测试里可以关掉 scip-go。
- `util/command.ts`：从 `llm/cli/command.ts` 抽出通用的 `findCommand(name, { envVar, extraDirs })`（环境变量 → PATH → `commonCliDirs` → `extraDirs`），带 30 秒缓存（和 `llm/cli/command.ts:25-27` 一致，用户装上 scip-go 后长时间运行的服务也能找到）。`resolveCliCommand` 保留为包装函数，CLI 模型服务的已有测试不变。
- `scip/runner.ts`：`runProcess` 改为接收可执行文件路径，用 `detached` 建进程组，中止和超时时结束整组；`killActiveScipProcesses` 同时覆盖 scip-go。`llm/cli/process.ts` 不动。新增 `runScipGo({ bin, goBin, moduleDir, out, env, timeoutMs, signal })`。
- server `status` 接口（`server/src/http/routes/status.ts:39`）和 web 的 API 类型加 `edgeSources`、失败语言；`StatusBar.tsx:81` 的提示按语言区分（如“Python 调用关系解析失败”）；MCP 的空调用者说明（`server/src/mcp/format.ts:21-23`）同样按语言区分。
- MCP `similar` 工具：入参加 `language?: 'python' | 'go'`，默认 `python`；描述改为“Python 或 Go 代码”。

### 4.4 关键流程

**提取**：`incremental.ts` 里支持级别为 `full` 且 `languageSupport(language)` 存在的文件进入提取输入（带 language）。`extractWithCache` 按语言取解析器和提取函数。Go 文件提取前，从文件清单里找出所有 `go.mod`（`vendor/`、`testdata/` 下的除外），读出 module 路径，作为 `ExtractContext.goModules`；Go 文件的缓存 key 并入它所属的 module 路径（`go.mod` 的 module 行变了才失效）。

**快照目录**：
- `PROJECT_CONFIG_FILES` 加 `go.mod`、`go.sum`、`go.work`、`go.work.sum`。这几个文件放进工作区快照目录时**复制**，不硬链接到上一个快照（`linkFromPrevious`，`incremental.ts:93-99`），go 命令即使写了它们也不会改到上一个快照。
- `vendor/modules.txt` 和 `vendor/` 下的 `.go` 文件照常放入。
- `//go:embed` 引用的资源文件不放入：实测缺少这些文件时 scip-go 仍正常产出完整索引。

**scip-go 运行**：
1. 查找命令：`findCommand('scip-go', { envVar: 'CODEINSIGHT_SCIP_GO', extraDirs: ['~/go/bin', '$GOPATH/bin'] })`，`go` 同样查找。在 `prepare` 时完成。
2. 快照目录里没有 `go.mod` → 名称匹配，`reason=not_found`。
3. 有 `go.work` 时在它所在目录跑一次；否则对每个 `go.mod` 所在目录（`vendor/`、`testdata/` 下的除外）各跑一次。cwd 为该目录的真实路径。
   - 先用同样的环境变量跑 `go list -e -json ./...`，任何包带 `Error` 或 `DepsErrors` 时按失败处理（scip-go 加载依赖失败时仍返回 0、stderr 为空，只产出缺了引用的索引，并把找不到的包错标成标准库）。
   - 再跑 `scip-go index -o <out> --module-version=v0.0.0 --quiet`。固定 `--module-version`：不传时 scip-go 在 git 仓库里用提交号作版本，符号文字会随提交变化。
4. 环境变量：
   - module 目录下有 `vendor/modules.txt` 时 `GOFLAGS=-mod=vendor`，否则 `GOFLAGS=-mod=readonly`；
   - `CGO_ENABLED=0`（不调用 C 编译器）、`GOTOOLCHAIN=local`（不下载其他版本的 Go）；
   - `GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND="ssh -o BatchMode=yes"`（私有仓库不等待密码或主机确认）；
   - `GOPROXY`、`GOPATH`、`GOMODCACHE` 沿用用户环境（和用户自己 `go build` 一致，依赖不在本机模块缓存时会联网下载）。
5. 超时：新配置项 `scipGoTimeoutMs`，默认 120 秒，经 `ResolveInput.goTimeoutMs` 传入（scip-python 的 300 秒不变）。中止或超时时结束整个进程组。
6. 每个 module 的索引文档路径是相对 module 目录的，合并时加上 module 目录相对快照根目录的前缀。
7. 索引缓存文件为 `<contentKey>.go.scip`，`store/data-dir.ts` 清理快照时一起删除。
8. 全部成功 → `scipToEdges(..., goRules)`，来源 `scip`；任一步失败 → 日志 `scip_go_failed`，整体走名称匹配，来源 `name_match`、`reason=failed`，note 写原因的第一行。

**名称匹配之后的重新解析**：
- `reusable()` 保持同步，不变。
- 新增异步的 `needsReresolve(snap, resolver)`，只在持锁后的 `buildOrReuse` 里检查；`buildOrReuse` 的“只重跑解析”分支（`build.ts:243`）条件从“`resolver_status=failed`”扩展为“`resolver_status=failed` 或 `needsReresolve`”，走现有的 `retryResolve`，不重建快照目录、不重新提取。
- `needsReresolve` 的判断：`edge_sources.go.source === 'name_match'` 时，先 prepare Go 解析器：
  - `reason=not_found` 且现在找得到 scip-go → 重跑解析。
  - `reason=failed` 且距 `at` 超过 1 小时 → 重跑解析；不到 1 小时直接复用，避免离线时每次打开都卡 2 分钟。
  - 其余情况直接复用。
- 持锁前的快速复用路径（`build.ts:263`）不做这个检查，打开页面时不会因此变慢；下一次走到持锁路径时再重跑。

**SCIP 边转换的语言规则**（`resolve/scip-rules.ts`，`pythonRules` / `goRules`）：
- 行注释前缀：`#` / `//`。
- 续行计算：Python 用现有 `continuedLines`；Go 按括号配对，跳过字符串、反引号字符串、`//` 和 `/* */` 注释。
- 模块级定义：Python 以 `/__init__:` 结尾。Go 的包定义是以 `` `<包导入路径>`/ `` 结尾的符号（如 `` scip-go gomod example.com/gobasic v0.0.0 `example.com/gobasic/internal/order`/ ``），每个文件的 `package` 子句都有一个、都没有 `enclosing_range`，统一映射到该包的“代表文件”的 module 符号。代表文件：有包文档注释（`// Package xxx`）的非测试文件；没有时取文件名排序第一的非测试文件。名称匹配路径用同一个代表文件。
- 其他定义：函数 `NewService().`、方法 `Service#Create().`（值接收者和指针接收者相同）、struct/interface `Service#`、interface 方法 `Repo#Find.`（没有 `()`）、字段 `Service#repo.`；这些定义都有 `enclosing_range`，沿用现有的按位置和范围匹配。`local N` 跳过。
- import：scip-go 不给 import 标 Import 角色，`import "…/order"` 是对包符号的普通引用。Go 规则按引用所在行是否在 `importRows` 里判断 import 边（和 Python 一样用 `importRows`）。
- 调用：`s.repo.Find()` 产生对字段 `Service#repo.` 和 interface 方法 `Repo#Find.` 的引用，按现有的“调用位置”判断，调用边连到 interface 方法符号。

**局部类型推断**（`extract/go-types.ts`，提取时做，名称匹配和入口识别共用）：在一个函数内，变量的类型来自：接收者声明、参数声明、`var x T`、`x := &T{}` / `x := T{}`、`x := pkg.NewT(...)` / `x := NewT(...)`（取被调函数签名的第一个返回类型，跨文件时在跨文件处理时补）、结构体字段（`s.repo.Find()` 里 `s` 的类型的 `repo` 字段类型，限同包的 struct）。推断不出就留空。

**名称匹配**（`resolve/go-name-match.ts`，使用 `GoSymbolIndex`）：
- `ident`：同包的函数 → `high`。
- `pkg`：qualifier 对应项目内的包，按（包，名字）找函数 → `high`；外部包不出边。
- `selector` 且有 `receiverType`：按（类型所在包，类型，方法名）找方法 → `high`；类型是 interface 时连到 interface 方法符号。
- `selector` 没有 `receiverType`：同名方法在项目里唯一 → `low`；否则不出边。
- import：每个 import 了项目内包的文件，生成本文件 module 符号 → 该包代表文件 module 符号的一条 `import` 边。

**入口识别**（阶段5；提取时收集原始写法，跨文件处理时找处理函数）：

| 写法 | kind | framework | 处理函数参数 |
| --- | --- | --- | --- |
| `package main` 的 `func main()` | cli | `go` | main 本身 |
| `http.HandleFunc(p, h)`、`mux.HandleFunc(p, h)`、`http.Handle(p, h)` | http | `net/http` | 第二个 |
| `r.GET/POST/PUT/DELETE/PATCH/Any(p, ..., h)`，文件 import 了 gin | http | `gin` | 最后一个 |
| `e.GET/...(p, h, ...)`，import 了 echo | http | `echo` | 第二个 |
| `r.Get/Post/...(p, h)`、`r.HandleFunc(p, h)`，import 了 chi | http | `chi` | 第二个 |
| `&cobra.Command{Use: ..., Run/RunE: h}` | cli | `cobra` | Run/RunE 字段 |

- 处理函数是函数名、`pkg.Func`、方法值 `h.Create` 时，按名称匹配的规则找符号（方法值用局部类型推断出的 `h` 的类型）；是函数字面量时，给它建 4.2 里的 `func<N>` 符号。找不到处理函数时不生成入口。
- 路由分组：同一函数内 `g := r.Group("/api")`（gin、echo）、`r.Route("/api", func(r chi.Router){...})`（chi）的前缀拼到路径上；跨函数传递的分组不跟踪，路径只写本函数里能看到的部分。
- `detail` 带 `method`、`path`（cobra 为 `use`）。

**数据模型**：struct 字段标签含 `gorm:"` 或嵌入了 `gorm.Model` → `gorm`；否则含 `db:"` → `sqlx`；否则含 `json:"` → `json`。只带 `json` 标签的 struct 也算数据模型，类别单独显示为 `json`，和 gorm、sqlx 分开。

**分类**：测试为 `*_test.go`；生成代码为 `*.pb.go`、`*.pb.gw.go`、`*_gen.go`，以及前 2KB 内有一行匹配 `^// Code generated .* DO NOT EDIT\.$` 的 Go 文件。内容判断在 `incremental.ts` 读文件后做，`classify` 加 `isGeneratedContent(language, head)`。

**概览的 Go 事实**：概览重新读源码收集 import 和环境变量（`overview/external.ts:126-133` 现在只用 Python 解析器）。改为按语言选解析器；Go 文件用 `extract/go.ts` 导出的 `collectGoImports`、`collectGoEnvReads`（阶段3 实现，提取时也用它们填 `go.imports`、`go.envReads`）解析，module 路径从快照目录的 `go.mod` 读。

**相似代码**：
- Go 签名形状按 `(参数) 返回值` 解析，接收者不算参数。
- 同名重复规则对 Go：`main`、`init`、`New` 开头的函数不参与；方法要求包路径和类型名都相同；interface 方法（没有函数体）不参与相似比较。
- 片段按语言用 `<snippet>/snippet.py` 或 `<snippet>/snippet.go`。

**公开判断**：Go 符号按名字首字母大写判断；方法要求方法名和所属类型名都大写；interface 和 struct 都算类型。

### 4.5 公共逻辑

- `LanguageSupport` 注册表 → `extract/languages.ts` → 阶段1
- `sha1` 从 `extract/python.ts` 移到 `util/hash.ts`（现有调用方改 import，加进 `FINGERPRINT_EXTRA_MODULES`）→ 阶段1
- `supportLevelOf(language, path)` → `model/language.ts` → 阶段1（先加参数，Go 规则在阶段3）
- 按语言的 SCIP 边转换规则 → `resolve/scip-rules.ts` → 阶段2（Python 规则）、阶段4（Go 规则）
- `LanguageResolver`、`defaultResolver()`、`Resolver.prepare`、`edge_sources` 列、`needsReresolve` 框架、`findCommand`、进程组 → 阶段2
- Go module 路径计算（`go.mod` 解析）→ `extract/go-module.ts` → 阶段3，阶段4、6 使用
- Go 调用点、import、局部类型推断、struct 标签、环境变量读取的收集 → `extract/go.ts`、`extract/go-types.ts` （含导出的 `collectGoImports`、`collectGoEnvReads`）→ 阶段3；阶段5 在 `go.ts` 里加路由和 cobra 的收集、处理函数字面量符号，阶段4、6 不改 `go.ts`
- `GoSymbolIndex`（按包和名字找函数，按包、类型、名字找方法，代表文件）→ `extract/go-index.ts` → 阶段3，阶段4 名称匹配和阶段5 入口识别使用

### 4.6 备选方案

- **只用 scip-go，失败标 failed**：和 Python 一致，但大多数用户没装 scip-go，Go 项目就完全没有调用图。用户已选择加名称匹配后备。
- **用 `go/packages` 写一个自己的 Go 小程序产出调用边**：要随 CodeInsight 分发 Go 二进制或要求用户编译，维护成本比 scip-go 高。
- **按包（目录）而不是按文件建 module 符号**：更符合 Go 的语义，但现有概览、审查、symbol_key 都以文件为单位，改动面太大。用文件级 module 符号，qualifiedName 带包导入路径，概览里按目录分组已经能体现包。
- **函数字面量处理函数记到外层函数上**：一个 `main` 会挂几十个入口，审查只取第一个入口（`review/impact.ts:27`），`main` 还会被当成接口。改为给这些函数字面量单独建符号。

## 5. 兼容性与上线

- `snapshots` 加一列 `edge_sources`，旧库启动时自动加列，旧快照这一列为空、按“全部来自 scip”处理。
- 提取缓存的指纹加入 tree-sitter-go 版本后，所有缓存失效一次（Python 文件重新提取一次）。
- 解析器 version 按语言拆分：纯 Python 仓库的 version 只在本次阶段2 改 Python 相关解析代码时变一次，之后不受 Go 代码改动影响。
- 已有的 Go 仓库快照：Go 文件之前是 `none`，重新构建后变为 `full`；审查里 Go 文件从“文件级变更”变为符号级变更。
- 回滚：去掉 `LANG_SUPPORT` 的 `go: 'full'` 即可让 Go 回到文件级；`edge_sources` 列留着不影响旧代码。

## 6. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| scip-go 的符号格式、运行条件和预想的不一样 | 定义对不上符号，调用边少 | 阶段0 先实际跑；scipToEdges 已有“定义对不上比例”的 note |
| scip-go 需要下载依赖，离线或私有仓库时失败或很慢 | 构建变慢 | 单独的 120 秒超时；失败改用名称匹配，1 小时内不重试；`GOTOOLCHAIN=local`、`GIT_TERMINAL_PROMPT=0`、ssh 不交互 |
| scip-go 调用 `go list` 时执行项目里的代码 | 安全 | `CGO_ENABLED=0`；`go list` 不执行 Go 代码；不跑 `go generate` |
| go 命令改写快照目录里的 `go.mod`/`go.sum` | 上一个快照的内容被改 | Go 配置文件复制不硬链接；`-mod=readonly` 或 `-mod=vendor`；测试检查跑完后 `go.mod`/`go.sum`/`go.work.sum` 的 hash 不变 |
| 名称匹配误连 | 调用图出现错误的边 | 有推断类型时才标 `high`；没有类型时只在同名方法唯一时连，标 `low` |
| 多 module 仓库、`go.mod` 不在根目录 | 路径对不上 | 每个 module 跑一次，合并时加路径前缀；测试用 `go.mod` 在子目录的 fixture |
| 提交了 vendor 的项目 | 依赖代码淹没结果 | `vendor/`、`testdata/` 下的 Go 文件支持级别为 none |
| Python 行为被重构改变 | 已有功能回归 | 阶段1、2 不改任何已有测试的期望值，全量测试通过 |
| scip-go 运行失败（不是找不到）期间不复用调用边 | 混合仓库每个新工作区快照都重跑 scip-python | 只在 scip-go 确实运行失败时发生；失败原因写进日志和状态栏，用户可以修好环境或卸载 scip-go |
| scip-go 不输出 `enclosing_range`、包定义出现在每个文件 | 定义对不上或 import 边指向随机文件 | 阶段0 实测；Go 规则按符号范围匹配，包定义统一映射到代表文件 |

## 7. 测试方案

- **fixture**：`packages/core/test/fixtures/go-basic`：`go.mod` 放在子目录 `backend/`（module `example.com/gobasic`，只依赖标准库），`backend/cmd/server/main.go`（`func main`、`http.HandleFunc`、函数字面量处理函数）、`backend/internal/order/service.go`（struct、指针和值接收者的方法、包级函数、跨包调用、通过接口字段调用）、`backend/internal/order/repo.go`（interface）、`backend/internal/order/model.go`（gorm/json 标签的 struct，只做语法识别，不 import gorm）、`service_test.go`、`order.pb.go`、`vendor/` 下一个 `.go` 文件、仓库根目录一个 Python 文件（混合仓库）。gin、echo、chi、cobra 的写法、第三方 import 的外部依赖分类放在单元测试的内联源码里，避免 scip-go 需要下载依赖。
- **单元测试**：Go 提取（符号、命名、interface 方法、函数字面量符号、文档注释、签名、调用点、局部类型推断）、入口识别（各框架、方法值、函数字面量、路由分组）、数据模型、分类、名称匹配四种调用形式和 import 边、Go 注释和续行规则、SCIP 路径前缀、签名形状和同名方法规则、外部依赖分类（含第三方库）、公开判断。
- **集成测试**：go-basic 走完整快照构建（`GoResolver({ scip: false })`，名称匹配路径）；重试解析流程（还原文件后名称匹配的边数和第一次相同）；名称匹配后重新解析走 `retryResolve`（`resolveRetried=true`，快照目录不重建）；混合仓库 Python 解析失败时 Go 的边仍入库；`edge_sources` 和重新解析条件；本机有 scip-go 时跑 scip-go 路径（没有时跳过）；Go 的审查用例（两个提交之间改一个方法、移动一个函数，审查报告是符号级变更）。
- **回归**：全部已有测试不改期望值。
- **手工验证**：用一个真实的 Go 项目打开网页，看概览、调用图、入口列表、状态栏提示。

## 8. 开发计划

- [x] 阶段0：scip-go 实测
  - 涉及模块：无代码改动（结果写进本方案 4.4）
  - 依赖：无
  - 内容：安装 scip-go 到本机 `~/go/bin`；在临时目录写一个 Go 小项目（两个包、interface、方法、包文档注释、`go.mod` 在子目录、一个 `//go:embed`、一个 `vendor/` 版本），用 4.4 的环境变量跑 scip-go；用 `scip/reader.ts` 读出索引，记录：包定义出现在哪里、函数/方法/interface 方法的符号格式、有没有 `enclosing_range`、文档路径是否相对 module 目录、缺少 embed 文件时能否产出索引、`-mod=vendor` 是否正常、耗时
  - 完成标准：本方案 4.4 的“模块级定义”“没有 enclosing_range 时”“快照目录”三处改写成实测结论，并写明 scip-go 版本
  - 验证：`go install github.com/scip-code/scip-go/cmd/scip-go@latest`（模块已从 sourcegraph 改名为 scip-code）得到 scip-go v0.2.9（SCIP 绑定 v0.10.0）；小项目（go.mod 在子目录、interface、两种接收者、embed、vendor）跑 `scip-go index` 退出 0；`relative_path` 相对 module 目录；go.mod/go.sum 跑前后 hash 不变；缺 embed 文件仍完整产出；`-mod=vendor` 正常；现有 `scip/reader.ts` 读不出新版位置字段（已加到阶段2）；依赖加载失败时 scip-go 仍退出 0（已在 4.4 加 `go list -e` 检查）；4.4 已改写为实测结论

- [x] 阶段1：按语言分派的提取（Python 行为不变）
  - 涉及模块：packages/core/src/extract（languages.ts、cache.ts、index.ts、types.ts、python.ts）、packages/core/src/snapshot（incremental.ts、build.ts 的提取和 restoreExtracted 部分）、packages/core/src/model/language.ts、packages/core/src/util/hash.ts、packages/core/src/similar/index.ts、packages/core/src/overview/external.ts、packages/core/src/ask/build-proposal.ts、packages/core/src/resolve/scip-python.ts（sha1 的 import）、packages/core/src/review（supportLevelOf 调用）
  - 依赖：无
  - 内容：`LanguageSupport` 注册表和 Python 实现；`ExtractedFile.language`；`incremental.ts`、`build.ts`（restoreExtracted、日志字段）、`extract/cache.ts`（语法包列表来自注册表、`FINGERPRINT_EXTRA_MODULES`）按语言分派；`sha1` 移到 `util/hash.ts`；`supportLevelOf(language, path)` 加参数并改全部调用方
  - 完成标准：`pnpm --filter @codeinsight/core test`、`pnpm --filter @codeinsight/server test` 全部通过且没有改已有测试的期望值；`pnpm -r build` 通过；`grep -rn "getPythonParser\|extractPythonFile" packages/core/src/snapshot` 无结果
  - 验证：core 514 通过/10 跳过、server 187 通过/10 跳过，测试只补了 `supportLevelOf` 的路径参数和手写 `ExtractedFile` 的 `language`，期望值未改；`pnpm -r build` 通过；grep 无结果。改动 `extract/languages.ts`（新）、`util/hash.ts`（新）、`extract/index.ts`、`extract/cache.ts`、`snapshot/incremental.ts`、`snapshot/build.ts`、`model/language.ts`、`review/assemble.ts`、`similar/index.ts`、`overview/external.ts`

- [~] 阶段2：按语言组合的解析框架
  - 涉及模块：packages/core/src/resolve（types.ts、language-resolver.ts、scip-rules.ts、scip-edges.ts、scip-python.ts）、packages/core/src/scip/runner.ts、packages/core/src/snapshot（build.ts 的解析部分、incremental.ts 的 reuseEdges）、packages/core/src/store（schema.ts、edge_sources 读写）、packages/core/src/util/command.ts、packages/core/src/llm/cli/command.ts、packages/server/src/http/routes/status.ts、packages/server/src/mcp/format.ts、packages/web/src/app/StatusBar.tsx 和 web 的 API 类型
  - 依赖：阶段1
  - 验证方式：独立
  - 内容：`scip/reader.ts` 同时支持新旧两种位置字段（SCIP 绑定 v0.10 起位置写在字段 8/9、`enclosing_range` 在 10/11，旧的打包字段 1/7 为空，没写的字段为 0），用阶段0 的 scip-go 索引做测试样本；`Resolver.prepare`、`ResolveInput.goTimeoutMs`、`ResolveResult` 的 `sources`/`effectiveVersion`/`failed`；`LanguageResolver`、`defaultResolver()`；一个解析器实例先 prepare 再用于复用判断和解析；`runResolver` 处理部分语言失败和 hash 写入规则；`edge_sources` 列、写入、`reuseEdges` 复制；`needsReresolve` 框架和 `buildOrReuse` 的重跑解析分支；`scip-rules.ts` 抽出 Python 规则；`scipResolverCodeHash` 按语言拆分文件范围；`findCommand`（`resolveCliCommand` 保留为包装）；`runProcess` 进程组；status 接口、状态栏、MCP 说明按语言区分失败
  - 完成标准：core、server、web 的 `pnpm --filter <包> test` 全部通过且没有改已有测试的期望值；`pnpm -r build` 通过；新增 `language-resolver.test.ts` 覆盖：只跑出现的语言、一个语言失败时另一个语言的边入库且 `resolver_status=failed`、version 只含出现的语言、`edge_sources` 随边复用一起复制、`needsReresolve` 为真时走 `retryResolve`（用一个假的子解析器测试）；旧库启动后 `snapshots` 表有 `edge_sources` 列

- [ ] 阶段3：Go 符号提取、分类和快照接入
  - 涉及模块：packages/core/package.json、packages/core/src/extract（go.ts、go-types.ts、go-module.ts、go-index.ts、normalize.ts、languages.ts）、packages/core/src/classify、packages/core/src/model/language.ts、packages/core/src/snapshot/incremental.ts（Go 配置文件复制、生成代码内容判断）、packages/core/src/resolve/go.ts（只放不出边的占位实现）、packages/core/test/fixtures/go-basic
  - 依赖：阶段2
  - 内容：加依赖 `tree-sitter-go@0.25.0`；Go 解析器加载；Go 提取器（4.2 的符号和命名、interface 方法、签名、文档注释、bodyHash、规范化 token 的 Go 节点类型）；`go` 字段收集（import、调用点、局部类型推断、struct 标签、环境变量读取；`collectGoImports`、`collectGoEnvReads` 导出）；`restoreFile` 和 `completeForResolve`；`go.mod` 解析、包导入路径、缓存 key；`GoSymbolIndex` 和代表文件；跨文件 parentId；`LANG_SUPPORT.go='full'`、vendor/testdata 规则；Go 配置文件放入快照目录并复制；测试和生成代码识别（含内容判断）；go-basic fixture
  - 完成标准：新增 `extract-go.test.ts`、`go-types.test.ts`、classify 的 Go 用例通过；go-basic 快照构建测试能查到 `example.com/gobasic/internal/order.Service.Create` 方法符号和 interface 方法符号，`service_test.go` 的 `isTest=true`，`order.pb.go` 的 `isGenerated=true`，`vendor/` 下文件的 `supportLevel='none'`；Go 文件的提取结果经过缓存读回后 `go.imports` 不为空；全部已有测试通过

- [ ] 阶段4：Go 调用关系（scip-go 和名称匹配）
  - 涉及模块：packages/core/src/resolve（go.ts、go-name-match.ts、scip-rules.ts 的 Go 规则）、packages/core/src/scip/runner.ts（runScipGo）、packages/core/src/store/data-dir.ts、packages/core/src/config（scipGoTimeoutMs）、packages/core/src/snapshot/build.ts（needsReresolve 的 Go 条件）、packages/web/src/app/StatusBar.tsx（名称匹配提示）
  - 依赖：阶段0、阶段3
  - 验证方式：独立
  - 内容：scip-go 和 go 查找；`runScipGo`（先 `go list -e -json ./...` 检查加载错误，再 `scip-go index`，固定 `--module-version`；环境变量、go.work 和多 module、路径前缀、超时、中止、索引缓存和清理）；Go 的 SCIP 规则（注释、续行、包定义映射到代表文件、import 按 importRows 判断）；名称匹配（四种调用形式、import 边）；`GoResolver` 先 scip-go 后名称匹配，返回 `sources` 和 `effectiveVersion`；`needsReresolve` 的三种情况；状态栏提示：Go 调用关系来自名称匹配时显示“Go 调用关系来自名称匹配（未找到 scip-go / scip-go 运行失败），可能不完整”，未找到时附上 scip-go 的安装命令
  - 完成标准：`go-name-match.test.ts` 覆盖 ident、pkg、有推断类型的 selector、经 interface 字段调用、同名唯一、同名不唯一、import 边指向代表文件；go-basic 快照在 `scip: false` 时 `resolver_status=ok`、`edge_sources.go.source='name_match'`、有跨包的 `call` 和 `import` 边；重试解析后名称匹配的边数和第一次相同；`needsReresolve` 三种情况各一个测试；本机有 scip-go 时集成测试的 scip 路径通过，`go.mod` 在子目录时定义能对上，跑完后快照目录里 `go.mod`/`go.sum` 的 hash 不变，验证记录写明 scip-go 版本和对上的定义比例；中止时 scip-go 进程组被结束；全部测试通过

- [ ] 阶段5：Go 入口和数据模型
  - 涉及模块：packages/core/src/extract（go.ts 的路由和 cobra 收集、处理函数字面量符号；go-entries.ts、go-models.ts；languages.ts 里 Go 的 resolveCrossFile）、packages/core/src/model/types.ts、packages/web/src/marks
  - 依赖：阶段3
  - 内容：4.4 表里的入口写法收集、处理函数字面量的 `func<N>` 符号、处理函数查找（函数名、`pkg.Func`、方法值、函数字面量）、路由分组前缀；数据模型识别；`ModelKind` 加 `gorm`、`sqlx`、`json`；网页模型标签
  - 完成标准：新增 `go-entries.test.ts` 覆盖 main、net/http、gin、echo、chi、cobra 各至少一个用例，以及方法值、函数字面量、gin 分组前缀、chi Route 前缀；`models.test.ts` 的 Go 用例覆盖三种类别和不是模型的 struct；go-basic 快照的 entries 里有 `cli/go` 和 `http/net/http`；`pnpm --filter @codeinsight/web test` 和 `pnpm --filter @codeinsight/web build` 通过

- [ ] 阶段6：概览、相似代码、审查和其他 Go 适配
  - 涉及模块：packages/core/src/overview（external.ts、external-table.ts、facts.ts）、packages/core/src/similar、packages/core/src/ask/sensitive.ts、packages/server/src/mcp/similar-tool.ts、packages/core/test（review 的 Go 用例）
  - 依赖：阶段3
  - 内容：概览按语言选解析器，Go 用 `collectGoImports`、`collectGoEnvReads`；Go 外部依赖（标准库判断：首段不含 `.`；项目内包按 module 前缀；第三方库分类表，含数据库、缓存、消息队列、Web 框架、RPC、配置、日志、云服务等常见库）；`isPublic` 的 Go 规则；Go 签名形状、同名重复规则、interface 方法不参与；`similar` 片段按语言选路径和提取器，MCP 工具加 `language` 参数；`sensitive` 加 `go.mod`、`go.sum`、`go.work`；Go 审查用例
  - 完成标准：`overview.test.ts` 的 Go 用例通过（第三方库按类别分组、标准库和项目内包不出现、环境变量被列出、首字母大写的符号算公开）；`similar.test.ts` 的 Go 用例通过（结构相同的两个 Go 函数相似度排第一，不同类型的 `String()`、各包的 `New()` 不算同名重复，Go 片段能搜到 Go 函数）；MCP `similar` 工具传 `language: "go"` 的 server 测试通过；Go 审查用例报告符号级变更和函数移动；全部测试通过

## 9. 待确认问题

无
