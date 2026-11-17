# CodeInsight Rust 语言支持技术方案

开发状态: TODO
方案评审: 通过（2026-11-17）
需求来源: 2026-11-17 用户需求：“增加rust语言支持”。参照已完成的 Go 支持（`docs/design/2026-11-16-go-support.md`），第一版覆盖符号和调用关系、入口识别、数据模型和外部依赖、相似代码和测试文件识别。2026-11-17 已确认：cargo features 用 `all`；先离线运行、失败再联网（超时 300 秒）；工具链读 `rust-toolchain(.toml)` 的 `channel`，已安装且带 rust-analyzer 就用，否则用 rustup 默认；serde 的 struct 标为 `json`；clap 子命令写进 `main` 入口的 `detail.subcommands`
作者: dongkai@zbyte-inc.com　　日期: 2026-11-17

## 1. 背景与目标

Go 支持做完后，提取层（`LanguageSupport`）和解析层（`LanguageResolver`、各语言边来源、名称匹配后重新解析）已经按语言分派。Rust 文件现在没有被识别（`EXT_LANG` 里没有 `.rs`），Rust 项目打开后看不到函数、调用图、入口和概览，审查里也只有文件级变更。

做完后要达到：

1. `.rs` 文件的支持级别为 `full`（包目录或工作区根目录下的 `target/`、`vendor/` 里的除外）。快照里有 Rust 的 module（每个文件一个）、function、method（impl 块里的方法、trait 里声明或带默认实现的方法）、struct/enum/union（kind=`class`）、trait（kind=`interface`）符号，名字、签名、行号、文档注释、body hash、规范化 token 都有值。
2. 找得到可用的 rust-analyzer 和 cargo、且能加载项目时，Rust 的调用边、引用边、import 边来自 `rust-analyzer scip`（`provenance=scip`）。找不到、运行失败、依赖加载失败或超时时改用名称匹配（`provenance=name_match`），`resolver_status` 仍为 `ok`，`edge_sources.rust` 记下来源和原因；之后 rust-analyzer 可用时按 Go 已有的规则重新解析。多个 cargo 根目录时各自运行，只有失败的根目录改用名称匹配。
3. 运行 cargo 和 rust-analyzer 时不执行项目里的任何代码，也不执行仓库里的配置指定的程序：build.rs、过程宏一律不编译不运行；仓库里的 `.cargo/config.toml`（rustc-wrapper、credential-provider 等）、`rust-toolchain.toml` 的 `path` 都不生效。
4. 同一个仓库里 Python、Go、Rust 共存时各自解析、边合并入库；Python 和 Go 的行为不变（已有测试不改期望值）。
5. 入口识别：bin crate 的 `fn main`（含 `#[tokio::main]` 等属性）为 cli；axum、actix-web、rocket 的路由（http，含能在同一函数里看到的路径前缀），处理函数可以是函数名、路径或闭包；clap 子命令写进 `main` 入口的 detail。
6. 数据模型：diesel、sqlx（`FromRow`）、sea-orm（`DeriveEntityModel`）的 struct 分别标 `diesel`、`sqlx`、`sea_orm`；只带 serde `Serialize`/`Deserialize` 的 struct 标 `json`。网页显示对应标签。
7. 概览：Rust 第三方依赖按 Cargo.toml 的依赖名分类，std/core/alloc、`crate::`/`self::`/`super::` 和工作区内的 crate 不算外部依赖；`std::env::var` 等的字面量参数和 `env!`/`option_env!` 列为环境变量；`pub` 的符号算公开（`pub(crate)` 等受限可见性不算）。
8. 相似代码能比较 Rust 函数（只和 Rust 比），签名形状按参数（不含 `self`）和返回值算；方法不参与同名重复；MCP `similar` 工具可以传 `language: "rust"`；MCP 按限定名查符号时支持 `a::b::f` 写法。
9. `tests/`、`benches/` 下的 `.rs` 文件、`#[test]`/`#[tokio::test]` 函数、`#[cfg(test)]` 模块里的符号识别为测试；文件开头有 `// @generated` 或 `// Code generated ... DO NOT EDIT` 的识别为生成代码。

## 2. 范围

**本次要做：**
- core：Rust 提取器（tree-sitter-rust）、Cargo.toml 解析和 crate/模块路径计算、调用点和局部类型收集、路径解析（`resolvePath`）、Rust 入口和数据模型识别
- core：`RustResolver`（rust-analyzer scip，不可用时名称匹配）；在仓库外建 cargo 运行目录、只放需要的文件；固定工具链和环境变量；Rust 的 SCIP 规则和索引预处理；名称匹配
- core：分类、相似代码、概览外部依赖和环境变量、公开符号判断、敏感文件列表加上 Rust
- core：几处 Go 专用但其实通用的小改动：SCIP 多根目录合并、按语言的 SCIP 缓存文件路径、调用判断允许语言规则跳过 turbofish、`runProcess` 支持逐段处理 stderr
- server：MCP `similar` 工具的 `language` 参数加 `rust`；`mcp/lookup.ts` 支持 `::` 分隔的限定名
- web：数据模型标签加 `diesel`、`sea_orm`；状态栏的名称匹配提示按语言给出原因和安装命令，Rust 缺 rust-src 时给出提示

**本次不做：**
- 自动安装 rust-analyzer、rust-src（只查找；状态栏提示 `rustup component add rust-analyzer rust-src`）
- 执行 build.rs 和过程宏，因此 build.rs 生成到 `OUT_DIR` 的代码、过程宏生成的项（derive 出来的 impl 等）不进索引
- 宏展开：宏调用（`println!`、项目里的 `macro_rules!`）不产生调用边，`macro_rules!` 不建符号；写在宏调用里的函数（如 tokio 的 `cfg_rt! { ... }`）提取层看不到
- trait 实现关系（`implement` 边）、trait 方法调用分派到具体实现（`dispatch` 边）
- 不作为路由处理函数的闭包不建符号（里面的调用记在外层函数上）
- `const` / `static` / `type` 别名 / enum 变体 / 字段作为符号
- `#[path = "..."]` 指定的模块文件位置（按默认的文件布局计算模块路径）
- 名称匹配路径的 `reference` 边（只生成 `call` 和 `import`）
- 其他 Web 框架（warp、poem、salvo、tonic 服务注册等）、其他 ORM
- 仓库里的 `vendor/` 依赖副本和 `.cargo/config.toml`（不进入 cargo 运行目录，见 4.4）
- Windows 上运行 rust-analyzer（`overrideCommand` 用的 `true` 命令在 Windows 上没有，Windows 下直接走名称匹配，`reason=not_found`，note 写明）

## 3. 现状分析

- **语言判断**：`packages/core/src/model/language.ts` 的 `Language` 没有 `'rust'`，`EXT_LANG` 没有 `.rs`；`LANG_SUPPORT` 有 `python`、`go`；`supportLevelOf(language, path)` 只看路径，Go 用 `inGoExcludedDir` 按任意深度排除；`isSupported(path)` 调用 `supportLevelOf`。调用方：`snapshot/incremental.ts`（`fileRow`、`isPlaced`，有完整文件清单）、`review/assemble.ts:18`（按 diff 里的单个文件计算，没有完整文件清单）、`review/versions.ts:95`（`isSupported` 预判断，没有完整文件清单）。
- **提取分派**：`extract/languages.ts` 的 `LanguageSupport` 和 `SUPPORTS` 注册表；`ExtractContext` 只有 `goModules`。`extract/parser.ts` 的 `cachedParser(pkg)` 按语法包根目录的 `<包名>.wasm` 加载。`extract/types.ts` 的 `ExtractedFile` 有 `language`、顶层 `importRows`、Go 专用的 `go?: GoFileFacts`。`extract/cache.ts` 的指纹包含语法包版本和 `FINGERPRINT_EXTRA_MODULES`（`:13`）。
- **提取上下文的两处构造**：`snapshot/build.ts:236` 的 `buildLocked` 用 `read.goModules`（来自 `ReadResult`，`incremental.ts:75`、`:123`）；`build.ts:260` 的 `snapshotExtractContext` 在重试解析时从快照目录重新读 `go.mod`（`collectGoModules`，读失败记 warn）。
- **快照目录和数据目录**：数据目录默认在仓库里（`config/index.ts:121` `DEFAULT_DATA_DIR='.codeinsight'`，`:564` 相对仓库解析），快照目录是 `<仓库>/.codeinsight/...` 的子目录。cargo 会从运行目录向上逐级读 `.cargo/config.toml`，也会向上找带 `[workspace]` 的 Cargo.toml，所以**在快照目录里运行 cargo，会读到用户仓库根目录的 `.cargo/config.toml` 和 Cargo.toml**：前者可能执行仓库指定的程序，后者会让快照里不属于该工作区的独立包 `cargo metadata` 失败。工作区快照由 `readAndPlace` 按 `isPlaced`（`incremental.ts:47`）放文件，`GO_CONFIG_FILES` 复制不硬链接；提交快照由 `exportArchive`（`build.ts:87-89`，`git/index.ts:320`）把整个提交解压进快照目录，`.cargo/config.toml`、`rust-toolchain.toml` 等都会在里面。
- **解析**：`resolve/language-resolver.ts` 的 `LanguageResolver` 按 `file.language` 分组调用子解析器、拼接 version、合并边和 `sources`；`defaultResolver()` 注册 python、go。`resolve/go.ts` 的 `GoResolver` 是“先外部工具、失败改名称匹配”的样板；它的 `scipGoVersion`（`:53`）按可执行文件路径和 mtime 缓存版本号。`resolve/edge-sources.ts` 的 `mayNeedReresolve`、`FAILED_RERESOLVE_AFTER_MS` 和 `build.ts:308` 的 `needsReresolve` 与语言无关。`FallbackReason`（`model/types.ts:7`）已有 `not_found | failed | disabled | no_module`；`EdgeSource`（`model/types.ts:10`）有 `source`、`reason`、`at`、`note`。解析超时在 `build.ts:190` 经 `ResolveInput` 传入。
- **SCIP 转边**：`resolve/scip-edges.ts` 的 `scipToEdges(index, files, sources, snapshotId, rules)`：`mapDefinitions` 把模块定义映射到文件 module 符号，其他定义按名字位置和 `enclosing_range` 对应提取层符号；**`scipToId` 是“SCIP 符号 → 一个 id”，同一个符号在多个文件里定义时后一个覆盖前一个**；`isCallAt`（`:104`）要求引用后面第一个字符是 `(`；`referenceEdge`（`:118-135`）对 `importRows` 内的**每一条**引用都生成 import 边。`resolve/scip-rules.ts` 的 `ScipLanguageRules`；Go 的规则和索引预处理在 `resolve/scip-rules-go.ts`。`resolve/code-hash.ts:6` 的 `SHARED_SCIP_RESOLVER_MODULES` 列出各语言解析版本共用的模块。
- **SCIP 运行和合并**：`scip/runner.ts` 的 `runProcess`（进程组、超时、中止）**只保留 stderr 最后 64KB**（`:92`）；`resolve/go-scip.ts` 的 `prefixDocument` / `appendScipDocuments` 与语言无关。`store/data-dir.ts:47` 的 `goScipPath` 和 `:363` 的清理只认 `.go.scip`；`removeStaleScipTemps`（`:68`）只清理数据目录里的 `<key>.scip.<pid>.tmp`。
- **命令查找**：`util/command.ts:95` 的 `findCommand(name, { envVar, extraDirs })`。
- **配置**：`config/index.ts` 的 `scipGoTimeoutMs`（`:39`、`:569`）。
- **MCP 符号查找**：`server/src/mcp/lookup.ts:17` 查询里含 `#` 就当 symbol_key（`path#kind#qualifiedName#signature`）；`:22` 按 `.` 拆限定名取最后一段做名字查找，`::` 写法查不到。Go 的函数字面量符号名为 `func<N>`，不含 `#`（`similar/features.ts:39`）。
- **其他 Go 分支**：`classify/index.ts`（`DEFAULT_GENERATED`、`isTestPath` 已把任意语言的 `tests/` 目录当测试、`isGeneratedContent`）；`similar/features.ts:42,142,165,220`、`similar/index.ts:245` 的 `SnippetLanguage`；`overview/external.ts:150,159`；`overview/external-table.ts` 的 `GO_EXTERNAL_TABLE`；`overview/facts.ts:226` 的 `isPublic`；`ask/sensitive.ts:15`（`build.rs` 已在列表里）；server `mcp/similar-tool.ts:13`；web `marks/marks.ts:24`、`app/StatusBar.tsx:75-103`（只看 `edgeSources.go`）。
- **模型字段**：`SymbolRow.isTest` 是符号级的；`ModelKind`（`model/types.ts:74`）已有 `sqlx`、`json`。`SymbolRow` 没有可见性字段，公开判断只能看 `displaySignature`。
- **测试**：`packages/core/test/*.test.ts`，Go 的测试和 fixture（`go-basic`、`scip-go-mini`）可作样板。各包 `pnpm --filter <包名> test`（vitest），根目录 `pnpm -r build`、`pnpm lint`。
- **依赖**：`tree-sitter-rust@0.24.0`（npm 最新版）包根目录自带 `tree-sitter-rust.wasm`，已实测能用现有的 `web-tree-sitter@0.27.2` 加载并解析 struct、impl、trait、`mod`、`macro_rules!`、属性。项目里没有直接依赖的 TOML 解析库，需要新增 `smol-toml`。
- **本机工具**：rustc/cargo 1.98.1，rustup 默认工具链 `stable-aarch64-apple-darwin`，rust-src 已装（`$(rustc --print sysroot)/lib/rustlib/src/rust`）。`~/.cargo/bin/rust-analyzer` 是 rustup 代理，组件没装时运行报 `Unknown binary 'rust-analyzer'`；本次已执行 `rustup component add rust-analyzer`，现为 1.98.1。`rustup which rust-analyzer` 给出实际组件路径 `~/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rust-analyzer`。

### rust-analyzer scip 实测结论（2026-11-17，rust-analyzer 1.98.1）

在临时目录建了一个两成员的 cargo workspace（lib crate 带 `mod` 文件和内联 `mod`、trait 和 impl、泛型 struct 字段调用 trait 方法、`pub use`、`#[cfg(test)] mod tests`、`tests/it.rs`；bin crate 有 `src/main.rs` 和 `src/bin/tool.rs`），另用 tokio 1.54.1 源码（约 15 万行）测耗时，再用带 build.rs 和本地 proc-macro crate 的 workspace 测安全配置：

- 命令：`rust-analyzer scip <dir> --output <file> --config-path <json>`，不传 `--output` 时写到当前目录的 `index.scip`。在 workspace 根目录跑一次即覆盖所有成员；`relative_path` 相对传入的目录。现有 `scip/reader.ts` 能直接读（新版位置字段）。
- 符号格式：`rust-analyzer cargo <包名> <版本> <路径>`。crate 根为 `crate/`，模块为 `order/`、`order/service/`；函数 `helper().`；struct/trait `Service#`、`Repo#`；字段 `Service#repo.`；trait 声明的方法 `Repo#find().`；固有 impl 的方法 ``impl#[`Service<R>`]create().``；trait impl 的方法 `impl#[MemRepo][Repo]find().`；impl 块本身 ``impl#[`Service<R>`]``（只作为引用出现）；宏 `macros/println!`；局部变量 `local N`。
- 模块定义：文件级模块（crate 根和 `mod` 文件）的定义在第 0 行第 0 列、`enclosing_range` 为整个文件；内联 `mod inner {}` 的定义在名字位置。函数、方法、类型的定义都有 `enclosing_range`。
- 重复符号：同一个包里的多个 crate 目标共用一个符号空间。两个 bin 目标各自的 `main()` 和 `crate/`、lib 和 `tests/it.rs` 的 `crate/` 都产生同名定义，rust-analyzer 在 stderr 打印 `Duplicate symbol`，仍退出 0。
- 调用：`self.repo.find(id)`（`repo: R`，`R: Repo`）产生对字段 `Service#repo.` 和 trait 方法 `Repo#find().` 的引用。跨 crate 调用（app → shop-core）正常。`use` 语句和表达式里路径的每一段都是一条普通引用，没有 Import 角色；`use super::*` 的 `*` 上没有引用。
- 依赖加载失败时仍退出 0：依赖解析失败时打一条 WARN ``cargo metadata failed and returning succeeded result with `--no-deps` ``，退出 0，索引里**跨 crate 的引用全部丢失**。这条 WARN 后面跟着很长的 cargo 错误和调用栈，stderr 总量可能超过 64KB。
- 特性：默认只启用 default features，tokio 只索引到 238 个文件；配置 `cargo.features = "all"` 后 488 个文件、7876 个定义。
- 耗时：小 workspace 约 2 秒；带 serde 依赖约 5 秒；tokio 首次（要下载依赖）23 秒、依赖已缓存时 4 秒（default features）/ 14 秒（all features）。离线（`CARGO_NET_OFFLINE=true`）时 tokio 因缺少 dev-dependency 回退到 `--no-deps`；tokio 在允许联网时生成了 `Cargo.lock`。
- **build.rs 和过程宏**：`rust-analyzer scip` 不读 `cargo.buildScripts.enable=false`、`procMacro.enable=false`——用这组配置时，build.rs 写的标记文件、本地 proc-macro（属性宏和 derive 宏）写的标记文件都出现了，并建了 target 目录。改用 `{"cargo":{"buildScripts":{"overrideCommand":["true"]},"features":"all"}}` 后：三个标记文件都不出现、没有建 target 目录；`#[pm::mark]` 标注的 `main` 函数体里对 `S` 和 `helper()` 的引用仍在；小 workspace 的索引和旧配置下的逐条比较完全相同（108 条定义和引用）。原理：build script 的构建和运行（含 proc-macro dylib 的编译）都改由 `true` 这条命令完成，它什么也不输出，rust-analyzer 就当没有 build script 输出、也没有可加载的 proc-macro。
- **仓库配置**：`.cargo/config.toml` 的 `build.rustc-wrapper` 在新配置下仍会被执行（cargo 查询 rustc 版本时调用）；设 `RUSTC=<工具链 rustc 绝对路径>`、`RUSTC_WRAPPER=`、`RUSTC_WORKSPACE_WRAPPER=`（空串）后不再执行。`rust-toolchain.toml` 的 `path` 会被执行（方案审查时已核实）。

### 可复用的已有代码

| 功能 | 已有实现（文件:类/方法） | 用在哪些阶段 |
| --- | --- | --- |
| 按语言注册提取实现 | `extract/languages.ts:LanguageSupport`、`SUPPORTS` | 阶段1、2、5 |
| wasm 语法加载、解析器缓存 | `extract/parser.ts:cachedParser` | 阶段1 |
| token 规范化、shingle | `extract/normalize.ts:normalizeTokens`（加 Rust 节点类型） | 阶段1 |
| symbol_key、去重后缀、符号组装 | `model/symbol-key.ts:makeSymbolKey`、`extract/symbols.ts` | 阶段1 |
| 提取缓存和缓存 key 附加信息 | `extract/cache.ts`、`snapshot/incremental.ts:cacheModule` | 阶段1 |
| 读多个配置文件、读失败记 warn | `extract/go-module.ts:collectGoModules` | 阶段1 |
| 配置文件复制不硬链接 | `snapshot/incremental.ts` 的 `GO_CONFIG_FILES` 处理 | 阶段1 |
| 按语言组合解析、边来源、重新解析 | `resolve/language-resolver.ts`、`resolve/edge-sources.ts`、`snapshot/build.ts:needsReresolve` | 阶段4 |
| “外部工具 + 名称匹配后备”的解析器结构 | `resolve/go.ts:GoResolver`（照着写 `RustResolver`） | 阶段4 |
| SCIP 索引预处理 | `resolve/scip-rules-go.ts:prepareGoIndex`（`prepareRustIndex` 的样板） | 阶段3 |
| SCIP 读取、转边 | `scip/reader.ts`、`resolve/scip-edges.ts:scipToEdges` | 阶段3 |
| SCIP 多根目录合并（加路径前缀） | `resolve/go-scip.ts:prefixDocument`、`appendScipDocuments`（移到 `scip/merge.ts`） | 阶段3 |
| 子进程进程组、超时、中止 | `scip/runner.ts:runProcess` | 阶段3 |
| 进程已退出的临时文件清理 | `store/data-dir.ts:removeStaleScipTemps`、`isProcessAlive` | 阶段3 |
| 命令查找 | `util/command.ts:findCommand` | 阶段3 |
| 括号配对的续行计算 | `resolve/scip-rules-go.ts:goContinuedLines`（照着写 Rust 版） | 阶段3 |
| 跨文件入口处理函数查找、函数字面量符号 | `extract/go-entries.ts`、`extract/go-routes.ts`、`extract/go-decls.ts` 的写法 | 阶段5 |
| 外部依赖分类和汇总 | `overview/external.ts`、`overview/external-table.ts` | 阶段6 |
| 相似度计算、同名规则 | `similar/index.ts`、`similar/features.ts` | 阶段6 |

## 4. 方案设计

### 4.1 整体思路

沿用 Go 的两层结构，不新增框架代码：提取层注册一个 Rust 的 `LanguageSupport`，解析层在 `defaultResolver()` 里加一个 `RustResolver`。

```
快照构建 ──提取──> LanguageSupport(python | go | rust) ──> ExtractedFile[]（rust 字段：use、调用点、属性、环境变量…）
         ──解析──> LanguageResolver
                    ├─ python → ScipPythonResolver
                    ├─ go     → GoResolver
                    └─ rust   → RustResolver
                                 ├─ 查找工具、确定工具链（在临时目录里运行，带 RUSTUP_TOOLCHAIN）
                                 ├─ 在 os.tmpdir() 下建运行目录，只放 .rs、Cargo.toml、Cargo.lock
                                 ├─ 每个 cargo 根目录：cargo metadata（先离线后联网）→ rust-analyzer scip → 检查依赖加载
                                 │     成功 → 合并索引 → prepareRustIndex → scipToEdges(rustRules) → 来源 scip
                                 └─ 找不到工具 / 失败的根目录里的文件 → rustNameMatchEdges → 来源 name_match + 原因
```

Rust 和 Go 不同的地方主要有四点：模块路径由 Cargo.toml 和文件布局决定（4.2）；cargo 和 rust-analyzer 会执行项目代码和仓库配置指定的程序，要在仓库外的运行目录里、用固定的工具链和环境变量运行，并用 `overrideCommand` 阻止 build script 和 proc-macro（4.4）；同一个包里多个 crate 目标的符号会重名，要在转边前区分（4.4）；路径的每一段都是一条引用，要去掉中间段（4.4）。

### 4.2 数据模型

**表结构**：无变化（`edge_sources` 列已有，`rust` 作为新的键）。`EdgeSource` 加可选字段 `warnings?: string[]`（JSON 里的新键，旧代码忽略），Rust 缺 rust-src 时为 `['rust_src_missing']`。

**代码里的类型**：
- `Language` 加 `'rust'`，`EXT_LANG` 加 `.rs`，`LANG_SUPPORT` 加 `rust: 'full'`。
- `target/`、`vendor/` 排除：只排除 Cargo.toml 所在目录或工作区根目录下一级的 `target/`、`vendor/`（如 `crates/core/target/`、`vendor/`），不按任意深度排除（项目里叫 `vendor` 的模块目录照常支持）。`model/language.ts` 加 `rustExcludedDirs(paths): Set<string>`（从文件清单里的 Cargo.toml 算出要排除的目录）和 `supportLevelOf(language, path, rustExcluded?)` 的可选第三个参数。调用方：
  - `incremental.ts`（`fileRow`、`isPlaced`）有完整文件清单，传入这个集合；
  - `review/assemble.ts` 改用目标快照里该文件 `FileRow` 已算好的 `supportLevel`（新版本文件看新快照、删除的文件看旧快照），快照里查不到时退回不带第三个参数的 `supportLevelOf`；
  - `review/versions.ts` 的 `isSupported` 只是“这次改动有没有可能涉及支持的文件”的预判断，不传排除集合，允许把 `target/` 下的 `.rs` 多判为支持；
  - `isSupported(path)` 内部调用 `supportLevelOf` 时不传第三个参数（行为同上）。
- `ExtractContext` 加 `rustCrates: ReadonlyMap<string, RustPackage>`（包目录 → 包信息）。两处构造都要填：`ReadResult` 加 `rustCrates`（和 `goModules` 一样在 `readAndPlace` 里读 Cargo.toml 得到），`build.ts:236` 传入；`build.ts:260` 的 `snapshotExtractContext` 同时从快照目录读 Cargo.toml（`collectRustCrates`，读失败记 warn 并跳过）。
- `ExtractedFile` 加 `rust?: RustFileFacts`（普通对象，提取缓存能直接序列化）：
  - `crate`（crate 名）、`target`（所属 crate 目标的根文件路径，区分 lib、各 bin、各集成测试）、`modulePath`（如 `["order", "service"]`）
  - `uses`：`use` 展开后的绑定，名字 → 完整路径（`use a::{b, c as d}` 展开；`use x::*` 记进 `globUses`）；`pubUses`：`pub use` 的再导出
  - `useLeaves`：每个 `use` 路径最后一段（含 `{}` 里各项）的位置；`use x::*` 取 `*` 前面那一段（`x`）的位置。SCIP 只保留这些位置上的 import 引用（4.4）
  - `modDecls`：`mod x;` 声明所在行
  - `calls: RustCallSite[]`：`{ callerId, line, col, form: 'path' | 'method', segments, receiverType? }`。`foo()`、`a::b::foo()`、`Type::new()`、`Self::m()` 为 path；`x.m()` 为 method，`receiverType` 为局部类型推断结果，推断不出为空
  - `structFields`（类型名 → 字段名 → 字段类型路径）、`fnResults`（函数/关联函数 → 返回类型路径，`Self` 换成 impl 的类型）、`genericBounds`（类型参数 → trait 路径，用于 `R: Repo`、`impl Repo`、`dyn Repo`）
  - `derives`（类型符号 id → derive 名和相关属性，如 `diesel(table_name)`）
  - `pathRoots`：代码里出现的路径表达式、宏路径、属性路径、`use` 路径的第一段（去重），用于外部依赖统计和依赖加载的兜底检查
  - `envReads`、`macroRanges`（宏调用的行范围）
  - `routes`、`attrRoutes`、`clapCommands`（阶段5 加入）
- `RustPackage`（`extract/rust-cargo.ts`）：`{ dir, name, libName?, targets: { kind: 'lib' | 'bin' | 'test' | 'bench' | 'example' | 'build', name, root }[], deps: string[], workspaceRoot?, toolchainChannel? }`。从仓库里的 `Cargo.toml` 读：
  - 默认布局：`src/lib.rs`（lib）、`src/main.rs`（bin，名字为包名）、`src/bin/*.rs`、`src/bin/*/main.rs`、`tests/*.rs`、`benches/*.rs`、`examples/*.rs`、`build.rs`，以及 `[lib]`、`[[bin]]`、`[[test]]` 等显式写的 `path`。
  - `deps`：`[dependencies]`、`[dev-dependencies]`、`[build-dependencies]`、`[target.*.dependencies]` 的键（`package = "..."` 改名的取键名），`workspace = true` 的依赖从 `[workspace.dependencies]` 取。
  - 工作区：`[workspace] members`（支持 `*` 通配）减去 `exclude`；`default-members` 不影响（rust-analyzer 索引全部成员），只读不用。
- `ModelKind` 加 `'diesel' | 'sea_orm'`。

**文件 → crate 目标和模块路径**（提取时按路径计算，不看 `mod` 声明，也不看根文件内容）：
- 文件就是某个目标的根文件 → 该目标，模块路径为空。
- `src/` 下的其他文件：包有 lib 目标时归 lib，否则归 `src/main.rs` 的 bin；`src/bin/<name>/` 下的归该 bin。模块路径为相对目标根目录的路径，`a/b.rs`、`a/b/mod.rs` 都是 `a::b`。
- `tests/<dir>/...`、`benches/<dir>/...`、`examples/<dir>/...` 子目录里的文件：一律按目录名建一个虚拟目标（如 `tests/common/mod.rs` 归虚拟目标 `tests/common`）。
- 不在任何包里的 `.rs` 文件：crate 名用所在目录名，模块路径为空。

**符号命名**（crate 名中的 `-` 换成 `_`，用 `::` 分隔）：

| 符号 | kind | name | qualifiedName | parentId |
| --- | --- | --- | --- | --- |
| 文件 | module | 文件名去掉 `.rs`（`mod.rs` 取目录名） | `<crate>::<模块路径>`，目标根文件为 `<crate>`（bin 目标用 bin 名） | null |
| 函数 | function | 函数名 | `<模块>::func`（内联 `mod` 的名字拼进路径） | module 符号 |
| 函数体里定义的函数 | function | 函数名 | `<外层函数>::inner` | 外层函数 |
| 作为路由处理函数的闭包（阶段5 加入） | function | `closure<N>` | `<外层函数>::closure<N>`（N 为外层函数里按出现顺序第几个闭包，从 1 开始，和 Go 的 `func<N>` 一致；不含 `#`，避免被 MCP 查找当成 symbol_key） | 外层函数 |
| struct / enum / union | class | 类型名 | `<模块>::Type` | module 符号 |
| trait | interface | trait 名 | `<模块>::Trait` | module 符号 |
| trait 里的方法（声明或默认实现） | method | 方法名 | `<模块>::Trait::m` | trait 符号 |
| 固有 impl 的方法 | method | 方法名 | `<impl 所在模块>::Type::m` | 同一 crate 目标里找得到该类型时为类型符号（跨文件在阶段2 的跨文件处理时补），否则为 module 符号 |
| trait impl 的方法 | method | 方法名 | `<impl 所在模块>::<Type as Trait<泛型参数>>::m`，如 `<Foo as From<u8>>::from` | 同上 |

- 原始标识符 `r#type` 的 `name` 和 qualifiedName 里都去掉 `r#`。
- `Type` 取 impl 目标类型去掉泛型参数和引用后的名字（`impl<T> Repo for Vec<T>` → `Vec`）。trait 部分保留泛型参数，按规范化后的文字写：去掉所有空白，再在逗号后加一个空格（`From< u8 >` → `From<u8>`，`Fn(A,B)->C` → `Fn(A, B)->C`），这样同一类型对 `From<u8>`、`From<u16>` 的两个实现不会撞名。
- `signature` 为空；`displaySignature` 为去掉函数体的声明，保留可见性、`async`、泛型和 where 子句，如 `pub async fn create(&self, id: u64) -> Option<String>`；类型为 `pub struct Service<R: Repo>`。
- 文档注释：声明前紧挨着的 `///` 行或 `/** */`（中间允许属性行）；文件 module 符号取开头的 `//!` 行。
- `bodyHash`：整个项的文字，含前面的属性（derive 变了算改动）。
- `isTest`：文件是测试，或符号在 `#[cfg(test)]` 模块里，或带 `#[test]`、`#[tokio::test]` 等以 `test` 结尾的属性。
- 宏调用里的项不提取。闭包符号里的调用记在闭包符号上，其他闭包里的调用记在外层函数上。

### 4.3 接口设计

- `extract/languages.ts` 加 `rust` 的 `LanguageSupport`：`grammarPackage: 'tree-sitter-rust'`，`extractFile` / `restoreFile` 用 `ctx.rustCrates`，`completeForResolve` 补跨文件的 impl 方法 parentId 和类型信息，`resolveCrossFile` 做 parentId 补全、入口和模型。
- `extract/cache.ts`：指纹除语法包外，加上 `smol-toml` 的版本（新增一个“影响提取结果的其他依赖包”列表）。
- `extract/rust-index.ts`：`RustSymbolIndex` 和 `resolvePath(file, segments): ResolvedPath | undefined`——第一段按顺序解析 `crate`/`self`/`super`/`Self`、`uses` 绑定、工作区内的 crate 名、当前模块里的同名项、`globUses` 指向的模块里的同名项；经过 `pub use` 再导出时最多跟三层；返回项内路径和对应符号（函数、类型、trait、模块文件），解析到外部 crate 或标准库返回 `{ external: crateName }`。名称匹配、入口处理函数查找、import 边都用它。
- `resolve/types.ts`：`ResolveInput` 加 `rustTimeoutMs`，`build.ts:190` 传入 `config.scipRustTimeoutMs`。
- `resolve/rust-tools.ts`：`findRustTools(): Promise<RustTools>`，见 4.4 第 1 步；`RustTools` 含 `rustAnalyzer`、`cargo`、`rustc`（绝对路径）、`toolchain`（rustup 工具链名，没有 rustup 时为空）、`version`、`rustSrc`（是否有 rust-src）。
- `resolve/rust-scip.ts`：`buildRustScipIndex({ snapshotDir, files, packages, tools, output, timeoutMs, signal, keepRunDir? }): Promise<RustScipResult>`，返回每个运行根目录的成功/失败和原因；`keepRunDir` 只给测试用（保留运行目录以便检查）。
- `resolve/rust.ts`：`class RustResolver implements Resolver`，`name='rust'`，`version` 为 `rust-analyzer@<版本>` 或 `name-match` 加 Rust 解析代码的 hash；构造参数 `{ scip?: boolean }`；`needsReresolve` 和 `GoResolver` 一样的三种情况。`defaultResolver()` 注册 `rust`。
  - 版本号缓存：rustup 代理升级工具链时代理文件本身不变，不能沿用 Go 按可执行文件 mtime 缓存的做法。有 rustup 时按 `rustup which rust-analyzer` 得到的实际组件路径 + mtime 缓存；没有 rustup 时按 `realpath(rust-analyzer)` + mtime 缓存。
- `resolve/scip-rules.ts`：`ScipLanguageRules` 加可选的 `callRest?(rest: string): string`，在 `isCallAt` 判断 `(` 之前去掉语言特有的前缀；Rust 用它去掉 turbofish（`::<T>`）。Python、Go 不设置，行为不变。
- `scip/merge.ts`：`prefixDocument`、`appendScipDocuments` 从 `resolve/go-scip.ts` 移过来，Go 改 import；加进 `resolve/code-hash.ts` 的 `SHARED_SCIP_RESOLVER_MODULES`。
- `scip/runner.ts`：`runProcess` 加可选 `onStderr(line: string)`，按行切分后逐行交给调用方（末尾 64KB 的保留不变）；新增 `runCargoMetadata(...)`、`runRustAnalyzerScip({ bin, cwd, out, configPath, env, timeoutMs, signal })`，都用 `runProcess`。
- `store/data-dir.ts`：`goScipPath` 改为 `languageScipPath(layout, contentKey, language)`（文件名 `<contentKey>.<language>.scip`，Go 的文件名不变），清理快照时删除所有语言的文件。`removeStaleScipTemps` 同时扫描 `os.tmpdir()` 里的 Rust 运行目录（命名见 4.4），进程不在且目录属于当前用户时递归删除。
- `config/index.ts`：新配置项 `scipRustTimeoutMs`，环境变量 `CODEINSIGHT_SCIP_RUST_TIMEOUT_MS`，默认 300 秒。
- server：MCP `similar` 工具 `language` 加 `'rust'`，`SnippetLanguage` 加 `'rust'`；`mcp/lookup.ts`：含 `#` 时仍按 symbol_key 处理（Rust 的符号名不含 `#`，只有和 Python、Go 一样的去重后缀 `#2` 出现在 symbol_key 里）；否则含 `::` 时按 `::` 拆、取最后一段为名字，再按 `baseQualifiedName` 全等过滤；含 `.` 的行为不变。
- web：`StatusBar.tsx` 的名称匹配提示改为遍历 `edgeSources` 里所有 `name_match` 的语言，原因和安装命令按语言给（Go 现有文案不变；Rust 为“未找到 rust-analyzer”“rust-analyzer 运行失败”“项目没有 Cargo.toml”，安装命令 `rustup component add rust-analyzer rust-src`）；`edgeSources.rust.warnings` 含 `rust_src_missing` 时提示“未安装 rust-src，标准库相关的调用可能不完整”和同一条安装命令。

### 4.4 关键流程

**提取**：`readAndPlace` 从文件清单里找出所有 `Cargo.toml`（已排除目录下的除外），用 `extract/rust-cargo.ts` 解析成 `rustCrates`，同时算出 `rustExcludedDirs`。Rust 文件的缓存 key 并入 `<包目录>\0<crate 名>\0<目标根文件>`（`cacheModule` 加 Rust 分支）。

**快照目录**（只决定放什么，不为 Rust 删除任何文件）：
- `PROJECT_CONFIG_FILES` 加 `Cargo.toml`、`Cargo.lock`，放入时**复制**（和 `GO_CONFIG_FILES` 一起处理）。
- 快照里某个运行根目录没有 `Cargo.lock`、但用户工作区对应位置有（通常是被 `.gitignore` 忽略的那份）时，从工作区复制一份进快照目录。工作区快照和提交快照都这样做（提交快照用的可能是另一个提交时的依赖版本，cargo 会自行调整，仍比从头解析依赖快）。
- 排除目录下的 `.rs` 文件不放入。`rust-toolchain`、`rust-toolchain.toml` 放入工作区快照（只为读取 `channel`，见下）；`.cargo/` 下的文件、`rust-analyzer.toml` 不放入。提交快照由 `exportArchive` 整体解压，这些文件都在，但它们不会进入 cargo 的运行目录，所以快照目录不做任何删除。

**rust-analyzer 运行**（`resolve/rust-tools.ts`、`resolve/rust-scip.ts`）：

1. **查找工具和工具链**（在 `prepare` 里做）。所有子进程（包括 `--version`、`rustup which`、`rustup default`、`rustup toolchain list`、`rustc --print sysroot`）都显式传 `cwd=os.tmpdir()`，确定工具链后的每一次调用都带 `RUSTUP_TOOLCHAIN`，不受当前目录里 `rust-toolchain.toml` 的影响：
   - `findCommand('cargo', { envVar: 'CODEINSIGHT_CARGO', extraDirs: ['~/.cargo/bin'] })`、`rust-analyzer`（`CODEINSIGHT_RUST_ANALYZER`）同样查找，`rustup` 可选。
   - 有 rustup：不带 `RUSTUP_TOOLCHAIN` 跑 `rustup default` 取默认工具链名，失败按 `not_found`。cargo 的 realpath 是 rustup 代理（文件名为 `rustup` 或 `rustup-init`）却找不到 rustup 时，按 `not_found`。
   - 工具链（运行时按根目录确定，`prepare` 只确定默认工具链）：从运行根目录往上到快照根目录，找最近的 `rust-toolchain.toml`（`[toolchain] channel`）或旧格式 `rust-toolchain`（整个文件就是 channel），只读 `channel`，其余字段（`path`、`components` 等）忽略；channel 只接受 `^[A-Za-z0-9._-]+$`，且出现在 `rustup toolchain list` 里、该工具链有 rust-analyzer 组件时才用，否则用默认工具链（日志 `rust_toolchain_fallback` 记原因）。用非默认工具链的根目录，rust-analyzer、rustc 路径和 rust-src 检查按该工具链重新取。
   - `RUSTUP_TOOLCHAIN=<工具链> rustup which rust-analyzer`、`rustup which rustc` 得到绝对路径；`rust-analyzer --version` 报 `Unknown binary` 时按 `not_found`，note 写安装命令。没有 rustup 时 rustc 取和 cargo 同目录的 `rustc` 的绝对路径。
   - `rustc --print sysroot` 下没有 `lib/rustlib/src/rust/library` 时记 `rustSrc=false`：仍然运行（项目内的定义和引用不依赖 rust-src），结果的 `warnings` 带 `rust_src_missing`。
   - Windows 上直接按 `not_found`（见本次不做）。
2. 快照目录里没有 `Cargo.toml` → 名称匹配，`reason=no_module`。
3. **运行根目录**：带 `[workspace]` 的 Cargo.toml 所在目录，加上不属于任何工作区成员的包目录；以下不作为运行根目录（文件照常提取，调用边用名称匹配）：路径中含 `tests`、`fixtures`、`testdata`、`examples` 目录、又没列进某个工作区 members 的包。
4. **运行目录**：在 `os.tmpdir()` 下建 `codeinsight-rust-<contentKey 前 16 位>.<pid>.<随机 6 位>/`，权限 0700。按快照里的相对路径放入：所有 Rust 文件（排除目录下的除外）、所有 `Cargo.toml`、`Cargo.lock`（都复制；`.rs` 先尝试硬链接，跨文件系统时复制）。不放其他任何文件，所以仓库里的 `.cargo/config.toml`、`rust-toolchain.toml`、`rust-analyzer.toml` 都不在运行目录里；运行目录的上级是系统临时目录，不会读到用户仓库根目录的 `.cargo/config.toml` 或带 `[workspace]` 的 Cargo.toml。cargo 仍会读 `CARGO_HOME` 下的配置，那是用户自己的。仓库 `.cargo/config.toml` 里的 credential-provider、registry 等配置因此不可达；依赖私有 registry 的项目会失败回退名称匹配（写进风险）。运行结束（成功、失败、超时、中止）都删除运行目录；进程被强行结束留下的由 `removeStaleScipTemps` 按名字里的 pid 清理。
5. 每个根目录（运行目录里对应的子目录）单独运行、单独记录结果，共用总超时：
   - `cargo metadata --format-version 1 --all-features --offline`（输出丢弃）；成功则本根目录后续都离线运行（`CARGO_NET_OFFLINE=true`）；失败则去掉 `--offline` 再跑一次，仍失败按 `failed` 处理。
   - `rust-analyzer scip . --output <运行目录>/<序号>.scip --config-path <运行目录>/ra-config.json`，配置为 `{"cargo":{"buildScripts":{"overrideCommand":["true"]},"features":"all"}}`。`true` 用 `findCommand` 得到的绝对路径（`/usr/bin/true` 或 `/bin/true`）。
   - 依赖加载检查：`onStderr` 逐行匹配 `` returning succeeded result with `--no-deps` ``，匹配到就记下；兜底：本根目录下文件的 `pathRoots` 里确实出现了本根目录某个包的 `deps` 里的依赖名，而索引里没有任何一条指向本根目录以外 crate（标准库 `std`/`core`/`alloc` 除外）的引用时，也按依赖加载失败处理（rust-analyzer 升级后提示文字变了也能发现；代码里没用到任何依赖的项目不会误判）。任一命中按 `failed` 处理。
   - stderr 里出现 `Blocking waiting for file lock` 时记日志 `cargo_lock_wait`（用户本机 cargo 正占着包缓存锁），超时后 note 写明原因。
6. **环境变量**（在用户环境的基础上）：
   - `RUSTUP_TOOLCHAIN=<第 1 步定的工具链>`（没有 rustup 时不设）、`RUSTUP_AUTO_INSTALL=0`；
   - `RUSTC=<第 1 步得到的 rustc 绝对路径>`；`RUSTC_WRAPPER=`、`RUSTC_WORKSPACE_WRAPPER=`（设为空串，cargo 把空串当作不使用 wrapper，并覆盖配置文件里的 `build.rustc-wrapper`）；
   - 从环境里删除 `CARGO_BUILD_RUSTC`、`CARGO_BUILD_RUSTC_WRAPPER`、`CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER`、`CARGO_BUILD_RUSTDOC`、`RUSTDOC`（直接删除，不设空串：`RUSTC`、`RUSTC_WRAPPER` 已经固定，这几个变量只需保证不存在）；
   - `CARGO_TARGET_DIR=<运行目录>/target`、`CARGO_TERM_COLOR=never`；
   - `GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND="ssh -o BatchMode=yes"`；
   - `CARGO_HOME`、代理设置沿用用户环境。
7. 超时 `scipRustTimeoutMs`（默认 300 秒，所有根目录共用），中止或超时时结束整个进程组。
8. 成功的根目录的索引，文档路径相对于运行目录里的根目录，和快照里的相对路径一致；按 `scip/merge.ts` 加上根目录相对快照根目录的前缀后合并，写到数据目录的 `<contentKey>.rust.scip` 作为缓存（同时在旁边的 `<contentKey>.rust.json` 记下失败的根目录和原因、`warnings`，缓存命中时沿用；清理快照时一起删除）。
9. 结果：
   - 全部根目录成功 → `prepareRustIndex` → `scipToEdges(..., rustRules)`，来源 `scip`；不在任何运行根目录下的 Rust 文件用名称匹配补边。
   - 部分根目录失败 → 成功的部分照上处理，失败根目录下的文件用名称匹配；`edge_sources.rust` 记 `name_match`、`reason=failed`，note 列出失败的根目录和第一行原因（1 小时后按已有规则重新解析）。成功根目录里指向失败根目录的调用会缺失（那边的定义不在索引里），写进风险。
   - 全部失败 → 日志 `scip_rust_failed`，整体走名称匹配，`reason=failed`。

**SCIP 索引预处理**（`resolve/scip-rules-rust.ts:prepareRustIndex`，需要源码）：
- 去掉不在文件清单里的文档、`local` 符号。
- 重复符号：同一个符号在多个 crate 目标的文件里都有定义时（多个 bin 的 `main()`、lib 和集成测试的 `crate/`），给这个符号的定义和引用都加上 `@<目标根文件>` 后缀；引用所在文件的目标里没有该符号的定义时，改用 lib 目标的定义（集成测试和 bin 引用 lib）；仍没有就丢弃这条引用。
- 只保留提取层建了符号的定义：以 `().` 结尾（函数、方法）、以 `#` 结尾（类型、trait）、文件级模块定义；字段、变体、内联 `mod`、impl 块、宏的定义去掉。位置落在 `macroRanges` 里的定义去掉，不计入“定义对不上”的比例。
- 路径中间段：引用后面（跳过空白）紧跟 `::` 的，是路径的中间段（`crate`、`order`、`Type::new` 里的 `Type`），去掉；但位置在 `useLeaves` 里的保留（`use x::*` 的 `x`）。`use` 行里只保留 `useLeaves` 位置上的引用，所以 `use crate::order::service::Service;` 只生成一条到 `Service` 的 import 边，`use super::*;` 生成一条到父模块文件的 import 边。
- `mod x;` 声明行（`modDecls`）上的引用去掉：父模块和子模块之间不出边。

**SCIP 边转换的 Rust 规则**（`rustRules`）：
- 注释：`//`、`/*` 开头的剩余文字跳过。
- 续行：按括号配对计算，跳过普通字符串（含转义）、原始字符串 `r"..."`/`r#"..."#`、字符字面量、`//` 和 `/* */`（可嵌套）注释；`'a` 这样后面没有配对引号的是生命周期，不当字符字面量。
- 模块定义：以 `/` 结尾、位置在第 0 行第 0 列的定义。
- `callRest`：去掉开头的 `::<...>`（尖括号配对）。宏引用后面是 `!`，不算调用。
- import：`use` 声明所在行记进 `importRows`，这些行上（预处理后只剩叶子）的引用为 `import` 边。
- 调用：经 trait 约束的字段调用（`self.repo.find()`）连到 trait 方法符号。

**局部类型推断**（`extract/rust-types.ts`，提取时做，名称匹配和入口识别共用）：一个函数内，变量类型来自：`self`（impl 的类型）、带类型标注的参数和 `let x: T`、`let x = T { .. }`、`let x = T::f(..)` / `let x = f(..)`（取被调函数的返回类型，跨文件时在跨文件处理时补）、`self.field` 的字段类型（同一 crate 目标里的 struct）。类型去掉 `&`、`&mut`、`Box<>`、`Arc<>`、`Rc<>`、`Option<>` 之外不做别的展开；泛型参数和 `impl Trait`、`dyn Trait` 记为对应 trait。推断不出就留空。

**名称匹配**（`resolve/rust-name-match.ts`）：
- `path` 形式：用 `resolvePath` 得到目标。是函数 → `high`；是 `Type::m` → 该类型的方法（固有和 trait impl 都找）→ `high`；是 `Trait::m` → trait 方法 → `high`；外部 → 不出边。
- `method` 形式：有 `receiverType` → 按（类型，方法名）找固有 impl 和 trait impl 的方法，`high`；类型是 trait → 连到 trait 方法。没有 `receiverType` → 同名方法在项目里唯一时 `low`，否则不出边。
- import：和 SCIP 路径一致，每个 `use` 叶子一条：叶子用 `resolvePath` 解析到项目内的项时，生成本文件 module 符号 → 该项所在文件 module 符号的 `import` 边；`use x::*` 的叶子是模块 `x`，边连到 `x` 的文件。

**入口识别**（阶段5；提取时收集原始写法，跨文件处理时找处理函数）：

| 写法 | kind | framework | 处理函数 |
| --- | --- | --- | --- |
| bin 目标根文件里的 `fn main`（含 `#[tokio::main]`、`#[actix_web::main]`） | cli | `rust` | main 本身 |
| `Router::new().route("/p", get(h).post(h2))`，crate 依赖了 axum | http | `axum` | `get`/`post`/`put`/`delete`/`patch`/`any` 的参数 |
| `.nest("/api", Router::new().route(...))`（同一表达式里的内联 Router） | http | `axum` | 前缀拼到路径上 |
| `#[get("/p")]`、`#[post(..)]`、`#[route("/p", method = "GET")]` 标注的函数，crate 依赖了 actix-web | http | `actix-web` | 函数本身 |
| `web::resource("/p").route(web::get().to(h))`、`App::new().route("/p", web::get().to(h))`、`web::scope("/api")` 内联前缀 | http | `actix-web` | `.to()` 的参数 |
| `#[get("/p")]` 等标注的函数，crate 依赖了 rocket | http | `rocket` | 函数本身；`.mount("/api", routes![a, b])` 在同一个 crate 里时把前缀拼到 a、b 的路径上 |
| clap：`#[derive(Subcommand)]` 的 enum 变体名、`Command::new("x")` 的子命令名 | — | `clap` | 不单独生成入口，子命令名写进同一 crate 目标的 `main` 入口的 `detail.subcommands` |

- 处理函数是函数名或路径时用 `resolvePath` 找；是闭包时给它建 4.2 里的 `closure<N>` 符号并作为处理函数。找不到处理函数时不生成入口。
- actix-web 和 rocket 的属性写法相同，按包的 `deps` 区分；两个都依赖时按文件的 `use` 判断。
- `detail` 带 `method`、`path`。

**数据模型**：struct 的 derive 和属性：`Queryable`/`Selectable`/`Insertable`/`AsChangeset`/`Identifiable` 或 `#[diesel(...)]` → `diesel`；`FromRow` → `sqlx`；`DeriveEntityModel` → `sea_orm`；否则 `Serialize`/`Deserialize` → `json`。enum 不算数据模型。derive 写成 `serde::Serialize` 这类路径时取最后一段。

**分类**：测试路径加 `benches/`，这条规则只对 `.rs` 文件生效（Python、Go 不变；`tests/` 规则本来就对所有语言生效）。生成代码：前 2KB 内有 `// @generated` 行，或匹配 `^// Code generated .* DO NOT EDIT`（`isGeneratedContent` 加 Rust 分支）。

**概览的 Rust 事实**：`overview/external.ts` 的 `FACT_LANGUAGES` 加 `rust`，用 `extract/rust-facts.ts` 导出的 `collectRustPathRoots`、`collectRustEnvReads`（阶段1 实现，提取时也用）。包信息从快照目录的 `Cargo.toml` 重新读（`collectRustCrates`）。
- 依赖统计用的第一段来自：`use` 路径、代码里的路径表达式（`reqwest::get(..)`、`serde_json::from_str`）、宏路径（`sqlx::query!`、`tracing::info!`）、属性路径（`#[tokio::main]`、`#[derive(serde::Serialize)]`）。只写了 `#[derive(Serialize)]` 而 `use serde::Serialize` 的，经 `use` 计入。
- `std`/`core`/`alloc`/`proc_macro`/`test` 为标准库不列出；`crate`/`self`/`super` 和工作区内 crate 名为项目内；其余在所在包 `deps`（`-` 换成 `_` 后比较）里的为第三方库，按 `RUST_EXTERNAL_TABLE` 分类（数据库：sqlx、diesel、sea-orm、rusqlite、postgres、tokio-postgres、mongodb、mysql；缓存：redis、deadpool-redis、moka；HTTP 客户端：reqwest、ureq、isahc、surf；消息队列：lapin、rdkafka、async-nats、pulsar；邮件：lettre；支付：async-stripe；存储：aws-sdk-s3、object_store、opendal、rust-s3；认证加密：jsonwebtoken、ring、argon2、bcrypt、openssl、rustls；LLM：async-openai；Web 框架：axum、actix-web、rocket、warp、poem、salvo、tonic、hyper），没匹配上的为“其他”；不在 deps 里的（如子模块名、局部变量开头的路径）忽略。
- 环境变量：`std::env::var`/`var_os`、经 `use` 导入后的 `env::var`/`var`、`dotenvy::var` 的字面量参数，以及 `env!`、`option_env!` 的字面量参数。

**相似代码**：
- 签名形状按参数（不含 `self`）和返回类型算。
- 同名重复：`main`、`new`、`default`、`fmt`、`from`、`drop` 和闭包符号不参与；方法不参与（各类型实现同一个 trait 方法是常态），只按相似度比较；函数只在模块路径不同时才算同名重复；没有函数体的 trait 方法不参与相似比较。
- 片段按语言用 `<snippet>/snippet.rs`。

**公开判断**：`displaySignature` 以 `pub ` 开头（`pub(crate)`、`pub(super)`、`pub(in ..)` 不算），且文件内包着它的内联 `mod` 都是 `pub`（不追溯 `mod` 声明的可见性）；trait 里的方法跟随 trait；trait impl 的方法跟随实现的类型（用阶段2 补好的 parentId 找到类型符号）；闭包符号不算公开。

### 4.5 公共逻辑

- Cargo.toml 解析（包、目标、依赖、工作区成员和 exclude）、文件 → crate 目标/模块路径、`rustExcludedDirs`、`collectRustCrates`、`rust-toolchain(.toml)` 的 channel 读取 → `extract/rust-cargo.ts`、`model/language.ts` → 阶段1；阶段3（运行根目录、工具链）、阶段5（按依赖判断框架）、阶段6（概览外部依赖）使用
- Rust 的支持级别规则和各调用方、`isPlaced`、Cargo.toml/Cargo.lock 复制和从工作区补 Cargo.lock、`ReadResult.rustCrates`、`snapshotExtractContext` 读 Cargo.toml → 阶段1
- 符号提取和 `pathRoots`、`envReads`、`derives`、`macroRanges`、`modDecls`、`useLeaves` 的收集 → `extract/rust.ts`、`extract/rust-facts.ts`（导出 `collectRustPathRoots`、`collectRustEnvReads`）→ 阶段1；阶段3、6 使用
- `use` 展开、调用点、局部类型推断 → `extract/rust-facts.ts`、`extract/rust-types.ts` → 阶段2
- `RustSymbolIndex`、`resolvePath`、跨文件 parentId → `extract/rust-index.ts` → 阶段2；阶段4 名称匹配和 import 边、阶段5 入口识别、阶段6 公开判断使用
- 路由和 clap 的收集、闭包符号 → `extract/rust.ts` → 阶段5（其他阶段不改 `rust.ts`）
- 工具和工具链查找、运行目录、环境变量、`scip/merge.ts`、`languageScipPath`、`ScipLanguageRules.callRest`、`runProcess.onStderr`、运行目录清理、`prepareRustIndex` → 阶段3
- 状态栏按语言的提示、`EdgeSource.warnings` → 阶段4

### 4.6 备选方案

- **只用 rust-analyzer，失败标 failed**：没装 rust-analyzer 的 Rust 项目就完全没有调用图。和 Go 一样加名称匹配后备。
- **开启 build.rs 和过程宏**：索引更完整，但打开项目时会编译并运行项目代码，而且慢很多；`rust-analyzer scip` 也不认关闭它们的开关，只能用 `overrideCommand` 强制不执行，不提供开启的选项。
- **在快照目录里运行 cargo、删除其中的危险配置文件**：数据目录默认在仓库里，cargo 向上查找时仍会读到用户仓库根目录的 `.cargo/config.toml` 和 Cargo.toml；而且要改动硬链接共享的快照目录。改为在系统临时目录里另建只含需要文件的运行目录。
- **只靠环境变量覆盖配置**：`.cargo/config.toml` 里的项很多（`target.<triple>.linker`、`[alias]`、`[env]`、credential-provider 等），逐项覆盖容易漏。运行目录里没有这些文件，环境变量只作为第二道防线。
- **提取时调用 `cargo metadata` 得到准确的 crate 目标**：提取阶段就要依赖外部工具，没装 cargo 时没法提取；按默认布局加 Cargo.toml 显式配置已经覆盖绝大多数项目。
- **按 `mod` 声明计算模块树**：更准确（能处理 main.rs 自己声明的模块和 `#[path]`），但模块路径就变成跨文件信息，单文件的提取缓存会因为别的文件改动而失效。
- **按 crate 而不是按文件建 module 符号**：和 Go 选择文件级 module 的理由相同。
- **用 rust-analyzer 的 LSP 模式**：要维护长连接和请求协议，`scip` 子命令一次产出全部引用，和现有 SCIP 流程一致。

## 5. 兼容性与上线

- 表结构不变；`edge_sources` 多一个 `rust` 键，`EdgeSource` 多一个可选的 `warnings`，旧代码读到未知键不受影响。
- 提取缓存指纹加入 tree-sitter-rust 和 smol-toml 版本后，所有缓存失效一次（Python、Go 文件重新提取一次）。
- `scip-edges.ts`、`scip-rules.ts`、`scip/runner.ts` 的改动和新加的 `scip/merge.ts` 属于各语言共用的解析模块，所有语言的解析版本变一次，已有快照的边重新解析一次。
- 已有的 Rust 仓库快照：`.rs` 之前是 `unknown`/`none`，重新构建后变为 `full`。
- 回滚：去掉 `LANG_SUPPORT` 的 `rust: 'full'` 即可让 Rust 回到文件级。

## 6. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| rust-analyzer 编译运行 build.rs 和过程宏 | 打开仓库就执行项目代码 | `buildScripts.overrideCommand=["true"]`（已实测标记文件不出现）；阶段3 独立验证，fixture 带写标记文件的 build.rs 和本地 proc-macro，跑完检查标记文件不存在 |
| 仓库里或其上级目录的 `.cargo/config.toml`（rustc-wrapper、linker、credential-provider）、`rust-toolchain.toml`（`path`）被执行 | 打开仓库就执行任意程序 | 在系统临时目录里另建运行目录，只放 `.rs`、Cargo.toml、Cargo.lock；固定 `RUSTUP_TOOLCHAIN`、`RUSTC`，`RUSTC_WRAPPER` 等设空串；所有子进程显式 `cwd`；测试覆盖提交快照里、仓库根目录（数据目录的上级）里放恶意配置 |
| `overrideCommand` 的行为随 rust-analyzer 版本变化 | build script 又被执行 | 安全测试在本机有 rust-analyzer 时每次都跑；版本号进解析器 version，升级后会重新解析，测试会先失败 |
| 依赖加载失败时 rust-analyzer 仍退出 0、索引缺跨 crate 引用 | 调用图悄悄缺边 | 先跑 `cargo metadata`；逐行读 stderr 匹配 `--no-deps` 提示（不受 64KB 截断影响）；兜底按“代码用到了依赖、索引里却没有任何跨 crate 引用”判断 |
| rust-analyzer 升级后提示文字变化 | 第一道检查失效 | 兜底检查不依赖文字；`cargo metadata` 检查不依赖 rust-analyzer |
| 依赖私有 registry 或 credential-provider 的项目 | 运行目录里没有仓库的 `.cargo/config.toml`，依赖拉不下来 | 失败回退名称匹配，note 写原因；用户可在 `CARGO_HOME` 的配置里设置（那份会被读到） |
| cargo 需要下载依赖，离线或网络慢时失败或很慢 | 构建变慢 | 先离线跑；从工作区补 Cargo.lock；单独 300 秒超时；失败改名称匹配，1 小时内不重试；git 不交互；`RUSTUP_AUTO_INSTALL=0` |
| 用户本机 cargo 正在编译，占着包缓存锁 | cargo 等锁直到超时 | 匹配 `Blocking waiting for file lock` 记日志，note 写明原因；超时后名称匹配，1 小时后重试 |
| 没装 rust-src | 标准库类型上的方法调用解析不全 | 仍运行，`warnings` 带 `rust_src_missing`，状态栏提示安装命令；项目内的定义和引用不受影响 |
| 运行目录残留在系统临时目录 | 占磁盘 | 每次运行结束删除；进程被强行结束的由 `removeStaleScipTemps` 按 pid 清理；运行目录只含 `.rs` 和 Cargo 文件，target 目录因 `overrideCommand` 基本为空 |
| 同一个包多个 crate 目标的符号重名 | 引用连到错误的 `main` 或文件 | 预处理时按目标区分重复符号，测试覆盖两个 bin 和集成测试 |
| 模块路径按文件布局计算，与 `mod` 声明不一致（lib.rs 和 main.rs 各自声明模块、`#[path]`） | qualifiedName 的 crate 和模块部分不准；名称匹配可能找错或找不到；SCIP 路径下定义按位置对得上，但这些文件被算到错误的目标里，重复符号按目标区分时可能连到错误的定义 | 名称匹配找不到时不出边；测试用例覆盖 lib.rs 和 main.rs 各自声明 `mod` 的情况，记录实际结果 |
| 部分根目录失败 | 成功根目录里指向失败根目录的调用缺失 | 失败根目录列进 note 和状态栏；1 小时后重试 |
| 宏里定义的函数（tokio 的 `cfg_*!`）提取层看不到 | 这部分没有符号和边 | 不计入“对不上”比例；在本次不做里写明 |
| `features = "all"` 遇到互斥特性 | 部分代码的类型检查出错 | rust-analyzer 只做分析不编译，类型错误不影响产出索引 |
| 名称匹配误连 | 调用图出现错误的边 | 有推断类型才标 `high`；没有时只在同名方法唯一时连，标 `low` |
| Python、Go 行为被改变 | 已有功能回归 | `callRest`、`onStderr`、`supportLevelOf` 第三个参数都是可选项；`benches/` 规则只对 `.rs` 生效；全部已有测试不改期望值 |

## 7. 测试方案

- **fixture**：`packages/core/test/fixtures/rust-basic`，cargo workspace（不依赖任何外部 crate，不需要联网）：
  - `crates/core`（包名 `shop-core`）：`src/lib.rs`（`//!` 文档、`pub mod order;`、`pub use`、`#[cfg(test)] mod tests`）、`src/order/mod.rs`（`use super::*`）、`src/order/repo.rs`（trait 带默认方法、struct 实现 trait、同一类型实现 `From<u8>` 和 `From<u16>`）、`src/order/service.rs`（泛型 struct 字段经 trait 约束调用、`Type::new()`、turbofish 调用、内联 `mod`、函数体里的函数、`r#type` 原始标识符）、`tests/it.rs`、`tests/common/mod.rs`
  - `crates/app`（包名 `app`）：`src/lib.rs` 声明 `mod a;`、`src/main.rs` 声明 `mod cli;`（lib.rs 和 main.rs 各自声明模块）、`src/main.rs` 调用 core 和 `std::env::var("APP_PORT")`、`src/bin/tool.rs`（第二个 `main`）、`build.rs`（写标记文件到测试指定的目录，路径经环境变量传入，没传时什么也不做）
  - `crates/pm`（`proc-macro = true`，只用 `proc_macro`）：一个属性宏和一个 derive 宏，展开时写标记文件；`crates/app` 的 `main` 用属性宏标注、一个 struct 用 derive 宏
  - 一个带 `// @generated` 的文件、`crates/core/target/debug/x.rs` 和根目录 `vendor/dep/src/lib.rs`（检查支持级别为 none）、`crates/core/src/vendor/mod.rs`（不在排除范围，检查为 full）
  - axum、actix-web、rocket、clap、diesel、sqlx、sea-orm、serde 的写法和第三方依赖分类放在单元测试的内联源码和内联 Cargo.toml 里
- **单元测试**：Cargo.toml 解析（目标默认布局和显式 path、workspace 依赖、改名依赖、members 通配和 exclude）、`rust-toolchain(.toml)` channel 读取和非法 channel 拒绝、文件 → 目标和模块路径（含 `tests/common` 虚拟目标）、`rustExcludedDirs`；Rust 提取（各类符号、命名、trait impl 方法含 `<Foo as From<u8>>::from` 和 `From<u16>` 不撞名、`r#`、文档注释、签名、isTest、宏里的项不提取）；`use` 展开、调用点、局部类型推断、`resolvePath`；Rust 续行和 turbofish 规则；重复符号预处理、路径中间段和 use 叶子过滤（含 `use x::*`）；名称匹配各形式和 import 边（含 glob use，和 SCIP 路径一致）；运行根目录选择；运行目录里只有 `.rs`、Cargo.toml、Cargo.lock；环境变量构造（`RUSTC` 为绝对路径、wrapper 为空串、`CARGO_BUILD_RUSTC*` 不存在）；工具查找（rustup 代理无组件、cargo 是代理但找不到 rustup、`rustup default` 失败都为 `not_found`，所有子进程带 `cwd` 和 `RUSTUP_TOOLCHAIN`）；stderr 逐行匹配和兜底检查（代码没用到依赖时不误判）；入口（各框架、前缀、闭包、clap）；数据模型；分类（`benches/` 只对 `.rs`）；外部依赖分类（use、路径表达式、宏路径、属性路径）；公开判断；签名形状和同名规则；MCP `::` 限定名查找和闭包符号名不被当成 symbol_key。
- **集成测试**：
  - rust-basic 完整快照构建（`RustResolver({ scip: false })`，名称匹配路径）；重试解析（`snapshotExtractContext` 读 Cargo.toml）后边数和第一次相同；名称匹配后重新解析走 `retryResolve`。
  - 本机有 rust-analyzer 时跑 scip 路径（没有时跳过）：定义对上比例、两个 `main` 的调用边各在自己文件、app → shop-core 的调用边存在、属性宏标注的 `main` 里的调用边存在、`use` 只生成到叶子的 import 边、快照目录里的文件没有被改动或删除（hash 不变）、运行目录在运行后被删除。
  - **安全**（本机有 rust-analyzer 时每次都跑）：build.rs 和 proc-macro 的标记文件不存在；提交快照里放 `.cargo/config.toml`（`build.rustc-wrapper` 指向写标记文件的脚本）和 `rust-toolchain.toml`（`path` 指向同样会写标记的目录），标记文件不存在；**祖先目录有恶意配置**：把数据目录放在一个临时“仓库”里，仓库根目录放恶意 `.cargo/config.toml` 和带 `[workspace]`（不含快照里的包）的 Cargo.toml，独立包的 `cargo metadata` 仍成功、标记文件不存在；用户环境里设了 `RUSTC_WRAPPER`、`CARGO_BUILD_RUSTC_WRAPPER` 时同样不被执行。测试用 `keepRunDir` 保留运行目录，检查里面没有 build script 产物。
  - 依赖加载失败（Cargo.toml 写一个不存在的依赖、代码里 `use` 它，设 `CARGO_NET_OFFLINE=true`）时该根目录回退名称匹配、`reason=failed`；两个运行根目录一个失败时，另一个的边仍来自 scip。
  - 中止时进程组被结束、运行目录被删除；`removeStaleScipTemps` 删除已退出进程留下的运行目录、保留当前进程的；Rust 审查用例。
- **回归**：全部已有测试不改期望值。
- **手工验证**：用一个真实的 axum 或 actix-web 项目打开网页，看概览、调用图、入口列表、状态栏提示。

## 8. 开发计划

- [ ] 阶段1：Cargo 解析、文件归属、符号提取和快照接入
  - 涉及模块：packages/core/package.json、packages/core/src/extract（rust.ts、rust-facts.ts、rust-cargo.ts、parser.ts、normalize.ts、types.ts、languages.ts、cache.ts）、packages/core/src/model/language.ts、packages/core/src/classify、packages/core/src/snapshot（incremental.ts、build.ts 的提取上下文部分）、packages/core/src/review（assemble.ts、versions.ts）、packages/core/src/resolve/rust.ts（只放不出边的占位实现）、packages/core/test/fixtures/rust-basic
  - 依赖：无
  - 验证方式：独立
  - 内容：加依赖 `tree-sitter-rust@0.24.0`、`smol-toml`（版本进提取缓存指纹）；`getRustParser`；Cargo.toml 解析（含 workspace exclude）、`rust-toolchain(.toml)` channel 读取、文件 → 目标和模块路径（`tests/<dir>` 虚拟目标）、`rustExcludedDirs` 和 `supportLevelOf` 第三个参数，`incremental.ts` 传集合、`review/assemble.ts` 改用快照 FileRow 的 supportLevel、`versions.ts` 和 `isSupported` 不传；`ReadResult.rustCrates`、`build.ts` 两处提取上下文、缓存 key；Rust 提取器（4.2 的符号、命名含 trait 泛型参数规范化、`r#`、签名、文档注释、bodyHash、isTest、规范化 token 的 Rust 节点类型）；`pathRoots`、`envReads`、`derives`、`macroRanges`、`modDecls`、`useLeaves` 收集；`restoreFile`；`LANG_SUPPORT.rust='full'`；Cargo.toml/Cargo.lock 放入并复制、从工作区补 Cargo.lock；测试（`benches/` 只对 `.rs`）和生成代码识别；占位 `RustResolver`（来源 name_match/disabled，不触发重跑）并注册；rust-basic fixture（含 build.rs 和 pm crate）
  - 完成标准：新增 `rust-cargo.test.ts`、`extract-rust.test.ts` 和 classify 的 Rust 用例通过；rust-basic 快照构建测试能查到 `shop_core::order::service::Service::create`、`shop_core::order::repo::Repo::find`（父节点为 trait）、`shop_core::order::repo::<MemRepo as Repo>::find`、`<Foo as From<u8>>::from` 和 `<Foo as From<u16>>::from` 两个不同符号，`tests/it.rs` 和 `#[cfg(test)]` 里的函数 `isTest=true`，`crates/core/target/`、`vendor/` 下文件 `supportLevel='none'` 而 `src/vendor/mod.rs` 为 `full`，审查里 `target/` 下改动的 `.rs` 文件按快照记录显示为 none，Cargo.toml 复制不硬链接，提交快照里缺 Cargo.lock 时从工作区补上；重试解析时 `snapshotExtractContext` 得到的 `rustCrates` 和构建时相同；`pnpm --filter @codeinsight/core test`、`pnpm -r build` 通过且已有测试期望值未改

- [ ] 阶段2：调用点、局部类型推断和路径解析
  - 涉及模块：packages/core/src/extract（rust-facts.ts、rust-types.ts、rust-index.ts、languages.ts 的 completeForResolve 和 resolveCrossFile）
  - 依赖：阶段1
  - 内容：`use` 展开（`uses`、`globUses`、`pubUses`）、调用点收集、局部类型推断、字段和返回类型、泛型约束；`RustSymbolIndex`（按 crate、模块路径、名字找项；按类型找方法；trait 方法）和 `resolvePath`（crate/self/super/Self、uses、工作区 crate、同模块、globUses、`pub use` 三层）；跨文件的 impl 方法 parentId；`completeForResolve`
  - 完成标准：新增 `rust-types.test.ts`、`rust-index.test.ts` 通过，覆盖 `resolvePath` 各种第一段、`pub use` 再导出、外部 crate 返回 external、`self.repo` 经泛型约束推断为 trait、`let x = T::new()` 跨文件补返回类型；rust-basic 快照里 `Service::create` 的父节点为 Service struct、`<MemRepo as Repo>::find` 的父节点为 MemRepo；缓存读回后 `rust.uses` 不为空；`pnpm --filter @codeinsight/core test` 通过

- [ ] 阶段3：rust-analyzer scip 运行与安全隔离
  - 涉及模块：packages/core/src/resolve（rust-tools.ts、rust-scip.ts、scip-rules-rust.ts、scip-rules.ts、scip-edges.ts、code-hash.ts、go-scip.ts 的 import）、packages/core/src/scip（merge.ts、runner.ts）、packages/core/src/store/data-dir.ts、packages/core/src/config
  - 依赖：阶段1
  - 验证方式：独立
  - 内容：`scip/merge.ts` 抽出并加进共用模块列表；`languageScipPath` 和清理（含 `.rust.json`）；`ScipLanguageRules.callRest`；`runProcess.onStderr`；`findRustTools`（cargo/rust-analyzer/rustup 查找、所有子进程带 `cwd` 和 `RUSTUP_TOOLCHAIN`、rustup 代理和 `rustup default` 失败的判断、工具链 channel 选择、rustc 绝对路径、rust-src 检查、版本号按实际组件路径缓存、Windows 按 not_found）；运行根目录选择；`os.tmpdir()` 下的运行目录（命名、权限、只放需要的文件、结束时删除）和 `removeStaleScipTemps` 扩展；环境变量；每个根目录 `cargo metadata`（先离线后联网）、`rust-analyzer scip`（`overrideCommand` 配置）、依赖加载检查（stderr 逐行匹配和兜底）、等锁日志、前缀合并、超时、中止、缓存；`rustRules` 和 `prepareRustIndex`（重复符号、只留建了符号的定义、宏范围、路径中间段、use 叶子含 glob、`mod` 声明行）；`scipRustTimeoutMs`
  - 完成标准：`rust-scip.test.ts` 覆盖续行（原始字符串、生命周期、嵌套注释）、turbofish、重复符号按目标区分、路径中间段和 use 叶子过滤（含 `use super::*`）、多根目录前缀、运行根目录选择（fixtures/examples 下的包不作为根目录、exclude）、运行目录内容、环境变量构造、工具查找的三种 `not_found`、stderr 跨多段的 `--no-deps` 提示能匹配到、代码用到依赖而没有跨 crate 引用时按失败处理而没用到依赖时不按失败处理；本机有 rust-analyzer 时：rust-basic 的 `buildRustScipIndex` 加 `scipToEdges` 得到两个 `main` 各自文件里的调用边、app → shop-core 的调用边、属性宏标注的 `main` 里的调用边，快照目录文件 hash 不变，运行目录已删除；**build.rs 和 proc-macro 的标记文件不存在**；提交快照里的恶意 `.cargo/config.toml` 和 `rust-toolchain.toml`、祖先目录的恶意 `.cargo/config.toml` 和 `[workspace]` Cargo.toml、用户环境里的 `RUSTC_WRAPPER`/`CARGO_BUILD_RUSTC_WRAPPER` 都没有被执行，独立包 `cargo metadata` 成功；`keepRunDir` 保留的运行目录里没有 build script 产物；依赖加载失败时该根目录记 failed、另一个根目录成功；中止时进程组被结束、运行目录被删除；验证记录写明 rust-analyzer 版本和对上的定义比例；core 测试和 `pnpm -r build` 通过，已有测试期望值未改

- [ ] 阶段4：Rust 名称匹配、RustResolver 组装和状态栏
  - 涉及模块：packages/core/src/resolve（rust.ts、rust-name-match.ts、language-resolver.ts、types.ts）、packages/core/src/model/types.ts（EdgeSource.warnings）、packages/core/src/snapshot/build.ts（rustTimeoutMs）、packages/server/src/http/routes/status.ts 和 web 的 API 类型（如需透传 warnings）、packages/web/src/app/StatusBar.tsx
  - 依赖：阶段2、阶段3
  - 内容：名称匹配（path、method、import 边含 glob use，和 SCIP 路径一致）；`RustResolver` 替换占位实现：先 scip、失败根目录和不在根目录下的文件用名称匹配，`sources`（含部分失败、`warnings`）、`effectiveVersion`、`needsReresolve`；`build.ts:190` 传 `rustTimeoutMs`；状态栏按语言的名称匹配提示和 rust-src 缺失提示
  - 完成标准：`rust-name-match.test.ts` 覆盖 path（crate/self/super、use 别名、`pub use`、`Type::new`、`Self::m`）、有推断类型的 method、经 trait 约束字段调用、同名唯一、同名不唯一、import 边（含 `use super::*`，和 scip 路径得到的 import 边指向同一个文件）；rust-basic 在 `scip: false` 时 `edge_sources.rust.source='name_match'` 且有跨 crate 的 `call` 和 `import` 边；重试解析后边数相同；`needsReresolve` 三种情况；本机有 rust-analyzer 时完整快照构建 `edge_sources.rust.source='scip'`；一个根目录失败时 `reason=failed`、note 列出该根目录、另一个根目录的边 `provenance=scip`；`rust_src_missing` 时状态栏显示提示（web 测试）；core、server、web 测试和 `pnpm -r build` 通过，已有测试期望值未改

- [ ] 阶段5：Rust 入口和数据模型
  - 涉及模块：packages/core/src/extract（rust.ts 的路由、clap 收集和闭包符号、rust-routes.ts、rust-entries.ts、rust-models.ts、languages.ts）、packages/core/src/model/types.ts、packages/web/src/marks
  - 依赖：阶段2
  - 内容：4.4 表里的入口写法收集和处理函数查找（axum 链式和 nest 前缀、actix-web 属性和 resource/scope、rocket 属性和 mount 前缀、按依赖区分框架）、作为处理函数的闭包建 `closure<N>` 符号、clap 子命令写进 main 入口 detail；数据模型识别；`ModelKind` 加 `diesel`、`sea_orm`；网页模型标签
  - 完成标准：新增 `rust-entries.test.ts` 覆盖 main（含 `#[tokio::main]`、两个 bin）、axum（多方法链、nest 前缀、闭包处理函数生成 `closure<N>` 符号且还原后 id 不变）、actix-web（属性、resource、scope 前缀）、rocket（属性、mount 前缀）、actix 和 rocket 同写法按依赖区分、clap derive 和 builder；`models.test.ts` 的 Rust 用例覆盖 diesel、sqlx、sea_orm、json 和不是模型的 struct；rust-basic 快照的 entries 里有两个 `cli/rust`；`pnpm --filter @codeinsight/core test`、`pnpm --filter @codeinsight/web test`、`pnpm --filter @codeinsight/web build` 通过

- [ ] 阶段6：概览、相似代码、MCP、审查和其他 Rust 适配
  - 涉及模块：packages/core/src/overview（external.ts、external-table.ts、facts.ts）、packages/core/src/similar、packages/core/src/ask/sensitive.ts、packages/server/src/mcp（similar-tool.ts、lookup.ts）、packages/core/test（review 的 Rust 用例）
  - 依赖：阶段2
  - 内容：概览 Rust 事实（`collectRustPathRoots`、`collectRustEnvReads`、Cargo.toml 依赖、`RUST_EXTERNAL_TABLE`）；`isPublic` 的 Rust 规则；Rust 签名形状、同名重复规则、无函数体的 trait 方法不参与；`SnippetLanguage` 和 MCP `similar` 工具加 `rust`；`mcp/lookup.ts` 支持 `::` 限定名（`#` 判断在前）；`sensitive` 加 `Cargo.toml`、`Cargo.lock`、`.cargo/config.toml`、`.cargo/credentials.toml`、`rust-toolchain.toml`；Rust 审查用例
  - 完成标准：`overview.test.ts` 的 Rust 用例通过（第三方库按类别分组、只在路径表达式/宏/属性里出现的库也被列出、std 和工作区 crate 不出现、`env::var` 和 `env!` 被列出、`pub` 算公开而 `pub(crate)` 不算、trait impl 方法跟随类型）；`similar.test.ts` 的 Rust 用例通过（结构相同的两个函数相似度排第一，各类型的 `new()`、`fmt()` 不算同名重复，Rust 片段能搜到 Rust 函数）；server MCP `similar` 传 `language: "rust"`、按 `shop_core::order::service::Service::create` 查符号、按闭包符号的限定名查符号的测试通过，按 `.` 查 Python/Go 符号和按 symbol_key 查的已有测试不变；Rust 审查用例报告符号级变更和函数移动；`pnpm -r build`、`pnpm lint` 和全部测试通过

## 9. 待确认问题

无
