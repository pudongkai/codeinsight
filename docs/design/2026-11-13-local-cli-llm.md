# CodeInsight 本机 CLI 模型服务技术方案：用本机的 Claude Code / opencode 跑 AI 功能

开发状态: TODO
方案评审: 通过（2026-11-13）
需求来源: 2026-11-13 用户需求：“AI 功能可以直接使用本机的 Claude Code（`claude` CLI）或 opencode（`opencode` CLI），不需要 API Key；现有通过 API 调大模型的方式（anthropic、openai-compatible）保留”
作者: dongkai@zbyte-inc.com　　日期: 2026-11-13

## 1. 背景与目标

现在 CodeInsight 的 AI 功能（概览的模块和系统说明、审查的意图分析、问答）都要配置 API 地址和 API Key，直接发 HTTP 请求。很多用户本机已经装好并登录了 Claude Code 或 opencode（用订阅额度或它们自己配置的模型服务），却还要另外申请 API Key。

做完后要达到：

1. provider 新增 `claude-code`、`opencode` 两种。选它们时不需要 API Key，CodeInsight 每次调用起一个 `claude` / `opencode` 子进程，用它们已有的登录状态和模型配置。`anthropic`、`openai-compatible` 的行为不变（已有测试不改期望值）。
2. 配置项：命令路径（不填时在 PATH 和常见安装目录里找 `claude` / `opencode`）、模型（可空，用工具自己的默认模型）、附加环境变量（如 `https_proxy`）。配置存 `~/.codeinsight/settings.json`，优先级沿用“用户设置 > 环境变量 > 仓库配置”；仓库配置里的命令路径、附加环境变量被忽略并给出 warning，仓库配置也不能把 provider 设成这两种 CLI。
3. 概览的 AI 说明、审查的意图分析在 CLI provider 下能正常生成，结构和用 API 时一致；失败时日志和界面能分清“命令不存在”“未登录”“额度用完/限流”“超时”“输出格式不对”。
4. 问答在 CLI provider 下由 CLI 自己跑多轮推理，只能调用 CodeInsight 提供的 7 个查询工具（通过 MCP 提供），不能读写文件、执行命令、联网；回答以现有的 NDJSON 事件流返回（文字、工具调用过程），网页问答界面不改交互。
5. CLI 子进程在临时空目录里运行（`cwd` 和 `PWD` 都是临时目录），不读用户和项目的 CLAUDE.md、hooks、权限设置、项目配置，只从用户的 Claude Code 设置里取 `env`（代理、网关地址等）；Claude Code 不保存会话（`--no-session-persistence`），opencode 每次调用结束后删除本次会话；参数里没有用户可控的 shell 片段（不经 shell 启动），prompt 走 stdin，系统提示等走临时文件。
6. 网页设置对话框能选这两种 provider，选中时显示命令路径、模型、附加环境变量，隐藏服务地址和 API Key；“测试连接”检查命令存在、版本、已登录，再做一次最小调用（界面说明会消耗少量额度）；状态栏显示当前用的是 API 还是本机 CLI、配置来自哪里。
7. `codeinsight overview`、`ask`、`review` 命令通过同一个 `loadConfig` 也能用这两种 provider。

## 2. 范围

**本次要做：**
- core：provider 类型扩展、命令路径和附加环境变量的配置与优先级、仓库配置限制、CLI provider 的默认并发 2
- core：CLI 调用层（`core/src/llm/cli/`）：子进程启动、超时和中止、进程登记与结束、隔离参数、输出解析、错误分类、用量；Claude Code 和 opencode 两个客户端实现 `LlmClient.complete`
- core：结构化输出的 JSON Schema（概览各类请求、意图分析），`askJson` 把 schema 传给客户端（API 客户端忽略）
- core：CLI provider 的问答流程（`core/src/ask/cli-agent.ts`），把 CLI 的流式输出转成现有 `AskEvent`
- server：只含 7 个问答工具、绑定一个快照的 MCP 服务（复用 `runAskTool`）；cli 的 `codeinsight mcp --ask-tools` 启动它；serve 和 `codeinsight ask` 把启动方式传给 core
- server：设置接口支持新字段、CLI 的测试连接、status 增加来源和类型
- web：设置对话框、状态栏、问答提示和概览生成弹窗里的模型名显示
- 测试：假的 `claude` / `opencode` 脚本（core、server 测试 helpers），单测覆盖结构化输出、流式、错误分类、超时和中止、参数检查、MCP 工具调用；真实 CLI 的集成测试用环境变量开关，默认跳过

**本次不做：**
- Windows 上通过 `.cmd` / `.bat` 包装的命令（Node 不经 shell 不能直接执行它们）：命令路径必须是可执行文件（如原生安装的 `claude.exe`），否则测试连接提示“请填可执行文件路径”
- Claude Code 和 opencode 以外的 CLI（Codex、Gemini CLI 等）
- 把现有的通用 `codeinsight mcp` 加上问答工具（原因见 4.6）
- 问答的多轮会话复用 CLI 自己的会话（`--resume`）：每次提问都新起进程，历史由 CodeInsight 拼进 prompt
- opencode 的逐字流式：opencode `run --format json` 的文字事件按整段输出（见 3 节），网页上会一段一段出现
- 网页里修改并发数和费用上限（沿用环境变量 `CODEINSIGHT_OVERVIEW_CONCURRENCY` 等）
- 换算 Claude 订阅额度的剩余量；只记录 CLI 返回的 token 数和 `total_cost_usd`
- 附加环境变量存进系统钥匙串；和 API Key 一样只存权限 600 的文件
- Claude Code 的 `apiKeyHelper`（写在 `~/.claude/settings.json` 里、由 Claude Code 执行脚本取 key）：`--setting-sources ""` 下不会执行，CodeInsight 也不代为执行。用 apiKeyHelper 的用户改用 `claude` 登录，或把 key 写进附加环境变量 `ANTHROPIC_API_KEY`；测试连接发现用户设置里有 `apiKeyHelper` 且未登录时给出这条提示（见 4.4.6）

## 3. 现状分析

**LLM 调用层（`packages/core/src/llm/`）**
- `index.ts`：`LlmClient` 接口有 `provider`、`model`、`baseUrl?`、`complete(req: LlmRequest): Promise<string>`、可选的 `chat?(req: ChatRequest)`。`LlmError(message, status?, retryAfterMs?)`、`LlmTruncatedError`、`ToolsUnsupportedError`。`createLlmClient(cfg, {timeoutMs, idleTimeoutMs})` 按 provider 建 `AnthropicClient` / `OpenAiCompatibleClient`，默认超时 120s。`completeWithLog` 记 `llm_request` / `llm_response` / `llm_failed` 日志（只记 origin、模型、字符数，不记请求体和 key）。
- `ask-json.ts`：`askJson` 发一个请求，用调用方的 `parse` 校验，不合格时追加一条 assistant 回复和一条 `retryPrompt` 用户消息重试 1 次；429 / 5xx 按 `transientRetries` 等待后重试（看 `LlmError.status`）；截断不重试。请求里没有 JSON Schema，回复格式写在提示词里，`parseJsonReply` 能去掉 ```json 包裹。
- `chat.ts`：`ChatRequest`（system、messages、tools、toolChoice、maxTokens、signal、onText）、`ChatResult`（text、toolCalls、stop、usage?）、`chatWithLog`。两种 API 协议的流式解析在 `anthropic-chat.ts`、`openai-chat.ts`、`sse.ts`。
- `cache.ts`：`llmIdentity(client) = sha256(provider + baseUrl + model)`，概览的缓存 key 里用它；`readLlmCache` / `writeLlmCache`。
- `setup.ts`：`llmClientFromConfig(config, {client, skipped})` 把配置变成客户端或 `llm_not_configured` warning；`notifyLlmOnce` 第一次发送前提示一次。

**调用方**
- 概览：`core/src/overview/ai-setup.ts:overviewAiSetup` 建客户端、算 `identity`；`overview/summarize.ts:send` 调 `askJson`（`transientRetries: 2`），用 `mapPool(…, run.opts.concurrency, …)` 并发；`OverviewAiStats` 的 `inputTokens` / `outputTokens` 本来就是按 `estimateTokens`（`intent/summary.ts`）估算的，不用服务端返回的用量。请求定义和校验在 `overview/summarize-input.ts`（`moduleRequest`、`featureRequest`、`systemRequest`、`parseReply` → `req.validate`）。
- 审查意图分析：`core/src/intent/index.ts:askModel` 调 `askJson`；`review/llm-steps.ts` 用 `llmClientFromConfig`。
- 问答：`core/src/ask/agent.ts:runAsk` 自己跑工具循环：每轮 `chatWithLog` → 执行 `ASK_TOOLS` 里的工具（`ask/tools.ts:runAskTool`，7 个：`search_symbols`、`get_symbol`、`get_call_graph`、`read_source`、`grep_code`、`list_entries`、`get_module`）→ 发 `tool` / `tool_done` / `text` 事件；上限 `config.ask.maxRounds`（12）、`maxToolChars`（120000）、单个结果 8000 字符；整题超时 `ASK_TIMEOUT_MS` 5 分钟；结束时 `addLinkedRefs` 按回答里的 `sym:` 链接补查符号；`askClient` 要求客户端有 `chat`。事件类型在 `ask/events.ts`（`AskEvent`、`AskUsage`、`AskErrorCode`），web 通过 `@codeinsight/core/ask/events` 引用。提示词和历史在 `ask/prompt.ts`（`askSystemPrompt` 含当前概览，可能很长；`trimHistory`、`initialMessages`）。工具执行环境 `ask/tool-context.ts:AskToolContext`（repo、store、layout、snapshot、sendSource、overview、signal）。

**配置（`packages/core/src/config/index.ts`、`settings/`）**
- `settings/types.ts`：`LlmProvider = 'anthropic' | 'openai-compatible'`、`isLlmProvider`、`UserLlmSettings {provider, baseUrl, model, apiKey}`。`settings/index.ts:normalizeLlm` 校验每项，不合格的记日志后忽略；`updateUserSettings` 原子写、权限 600。
- `config/index.ts`：`llmSources` 按“用户设置 > 环境变量 > 仓库配置”取每项和来源，`baseUrl`、`apiKey` 不读仓库配置（`ENV_ONLY_LLM_KEYS` + `ignoredLlmKeys` 给 warning）；model 缺失时只有 anthropic 有默认值。`costLimits` 里 `overview.concurrency` 默认 4（`DEFAULT_OVERVIEW_CONCURRENCY`），环境变量定上限、仓库配置只能调低（`stricterLimit`）。

**MCP（`packages/server/src/mcp/`）**
- `server.ts:buildServer` 用 `McpServer` 注册 `review_changes`、`get_impact`、`find_similar`、`get_overview`，都通过 `context.ts:ensureWorkspaceSnapshot` 拿当前工作区快照（必要时建索引）。`runMcpStdio` 在 stdin 结束时关闭并等进行中的工作。`cli/src/commands/mcp.ts` 解析 `--repo`、`--data-dir` 后调用它。测试辅助 `server/test/helpers/mcp-stdio.mjs` 从 `../../dist/index.js` 起服务。

**server 和 web**
- `server/src/http/routes/settings.ts`：`parseLlmForm`（provider 只认两种）、`resolveUserLlm`（provider 变了不沿用已保存的 key）、`llmView`、`pingLlm`（`complete(PING)`，失败原因 `failureReason` 按 HTTP 状态分类）、`testLlm`（同一时间一个，超时 `app.llmTest.timeoutMs`）。
- `server/src/http/routes/status.ts`：`llm: {provider, model}`。`routes/chat.ts:askQuestion` 用 `askClient` 后 `streamAnswer` 写 NDJSON；整个服务最多 2 个问题同时回答（`jobs/ask-runs.ts`）。
- `web/src/settings/{SettingsDialog.tsx,useSettingsForm.ts,labels.ts}`：provider 下拉、服务地址、模型、API Key、测试连接；`web/src/api/types.ts:LlmProvider`；问答提示 `web/src/chat/notice.ts`、概览弹窗 `web/src/overview/GenerateDialog.tsx` 显示 `provider（model）`；工具名中文说明 `web/src/chat/tool-labels.ts`（按 7 个工具名）。

**本机 CLI 的核实结果**（本机 Claude Code 2.1.318、opencode v2.2.0，只跑了 `--help`、`--version`，以及在临时配置目录、无法连通的 API 地址下跑 `claude -p` 看未登录时的输出，没有向模型发请求）
- 用户 shell 里 `claude` 是 alias：`https_proxy=http://10.4.3.15:3128 claude`，实际可执行文件 `/opt/homebrew/bin/claude`；子进程拿不到 alias，所以需要“附加环境变量”。opencode 在 `~/.opencode/bin/opencode`，不一定在 GUI 启动的进程（JetBrains 插件拉起的 serve）的 PATH 里。
- Claude Code `-p`：stdin 作为 prompt（`echo hi | claude -p` 可用）；`--output-format json|stream-json`；`stream-json` 必须同时加 `--verbose`，否则退出码 1、stderr `Error: When using --print, --output-format=stream-json requires --verbose`；`--include-partial-messages` 输出逐字增量（`stream_event`）；`--json-schema <schema>`、`--tools ""`（关掉全部内置工具）、`--allowedTools`、`--disallowedTools`、`--mcp-config <文件或 JSON>`、`--strict-mcp-config`、`--setting-sources <sources>`（传空串被接受）、`--no-session-persistence`、`--disable-slash-commands`、`--permission-mode dontAsk`（未预先允许的工具一律拒绝）、`--model`、`--system-prompt` 都在 `--help` 里；`--system-prompt-file`、`--max-turns` 不在 `--help` 里但程序里有（`--bare` 的说明里也提到 `--system-prompt[-file]`）。
- `--bare` 不能用：它只认 `ANTHROPIC_API_KEY` 或 apiKeyHelper，不读 OAuth 登录（订阅用户会变成未登录）。`--safe-mode` 会关掉 MCP 服务，也不能用；`--restricted` 不用（`--tools ""` + `dontAsk` 已经覆盖它的作用）。
- 用户级和项目级 CLAUDE.md 只在加载 `user` / `project` 设置来源时读取，`--setting-sources ""` 下不读；另加 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 作为第二层。`--strict-mcp-config` 同时排除 claude.ai 账号里连接的 MCP 服务。
- `--setting-sources ""` 的代价：`~/.claude/settings.json` 里的 `env`（这台机器在里面配了 `https_proxy`、`http_proxy`、`all_proxy`）、`apiKeyHelper`、`ANTHROPIC_BASE_URL` 等也不读，CLI 可能连不上。方案只读出其中的 `env` 并入子进程环境（4.4.3 第 2 步），apiKeyHelper 不支持（见本次不做）。
- Claude Code 输出格式（实测）：`json` 模式一行结果 `{"type":"result","subtype":"success"|"error_max_turns"|"error_during_execution"|"error_max_budget_usd"|"error_max_structured_output_retries","is_error":bool,"result":"…","structured_output"?:…,"usage":{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,…},"total_cost_usd":…,"modelUsage":{…},"num_turns":…,"terminal_reason":…,"api_error_status":…}`。未登录时 `subtype` 仍是 `"success"`，但 `is_error:true`、`terminal_reason:"api_error"`、`result:"Not logged in · Please run /login"`，退出码 1。`stream-json` 依次输出 `system/init`（含 `tools`、`mcp_servers`、`model`）、`system/status`、`assistant`（出错时带 `"error":"authentication_failed"`、`"is_api_error_message":true`）、`result`。assistant 的 `error` 取值（程序里的枚举）：`authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`verification_required`、`billing_error`、`rate_limit`、`overloaded`、`invalid_request`、`model_not_found`、`server_error`、`unknown`、`max_output_tokens`、`cloud_credential_error`。
- `claude auth status --json` 不发模型请求，输出 `{"loggedIn":false,"authMethod":"none",…}`，未登录时退出码 1，测试连接可以先用它检查登录。
- 用 `--no-session-persistence` 时临时配置目录里没有会话记录，但 `.claude.json`（含按目录记的项目信息）仍会写；这是用户自己的 Claude 配置文件，接受（见风险）。
- 环境变量 `CLAUDE_CODE_DISABLE_CLAUDE_MDS`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 在程序里存在。
- opencode `run`：`--format default|json`、`--model provider/model#variant`、`--agent`、`--file`、`--auto`（自动同意权限，本方案不用）、`--standalone`（用私有服务，不连后台常驻服务）。不加 `--auto` 时，非交互运行遇到权限请求自动拒绝。
- opencode `--format json` 每行 `{"type":…,"timestamp":…,"sessionID":…,…}`，type 有 `step_start`、`text`（`part.text` 是一整段文字，在该段结束时才输出）、`reasoning`（加 `--thinking` 才有）、`tool_use`（`part.tool`、`part.state.status` 为 `completed`/`error`、`part.state.input`、`part.state.output`/`error`）、`step_finish`（`part.tokens`、`part.cost`、`part.reason`）、`error`（`error` 对象，同时 `process.exitCode=1`）。这是从 v2.2.0 程序里读出来的，没有文档，版本间可能变化。
- opencode 配置相关的环境变量：`OPENCODE_CONFIG_CONTENT`（内联配置）、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_DISABLE_PROJECT_CONFIG`、`OPENCODE_DISABLE_CLAUDE_CODE`（不读 Claude Code 的 CLAUDE.md 和 skills）、`OPENCODE_DISABLE_AUTOUPDATE`。MCP 配置格式 `{"mcp":{"<name>":{"type":"local","command":[…],"environment":{…}}}}`，MCP 工具名为 `服务名_工具名`（如 `codeinsight_search_symbols`）。权限配置支持 `ask` / `allow` / `deny`；agent 配置有 `steps`（最多几步）。
- opencode 配置按层合并，顺序为：全局配置目录 → `OPENCODE_CONFIG` → 项目配置 → `OPENCODE_CONFIG_CONTENT` → 系统管理配置。`OPENCODE_CONFIG_CONTENT` 在全局配置之后，只覆盖它写到的项（agent、权限、mcp），用户全局配置里的 provider、模型、登录都保留；但全局配置里的插件和 MCP 服务仍会加载。`OPENCODE_CONFIG_DIR` 会替换整个全局配置目录（登录信息在数据目录，不受影响），用户的 provider 和模型设置也一起丢掉。
- `opencode run` 在 stdin 不是终端时读 stdin，拼在消息参数后面；也会用 `process.env.PWD ?? cwd` 决定工作目录，所以只改 `spawn` 的 `cwd` 不够，继承来的 `PWD` 会让它在用户仓库里运行。
- opencode 每次 `run` 会建一个会话并保存；`opencode session delete <sessionID>` 可以删除（会话 id 在每行输出的 `sessionID` 里）。
- opencode 的错误名：`ProviderAuthError`、`APIError`（带 `statusCode`、`isRetryable`）、`MessageOutputLengthError`、`ContextOverflowError`、`ContentFilterError`、`StructuredOutputError`、`MessageAbortedError`。

**测试**
- 各包测试命令：`pnpm --filter @codeinsight/{core,server,cli,web} test`；e2e `pnpm --filter @codeinsight/web test:e2e`（先 `pnpm -r build`）；根目录 `pnpm -r build`、`pnpm lint`、`pnpm -r test`。
- 现有测试辅助：`core/test/helpers/fake-llm-server.mjs`（假 API 服务）、`core/test/helpers/ask-env.ts`、`server/test/helpers/{env.ts,mcp-stdio.mjs}`；真实仓库的集成测试用 `describe.skipIf(!process.env.CODEINSIGHT_CLAUVE)` 默认跳过（`core/test/clauve.integration.test.ts`）。

### 可复用的已有代码

| 功能 | 已有实现（文件:类/方法） | 用在哪些阶段 |
| --- | --- | --- |
| 配置合并、来源、仓库配置不可信项的 warning | `core/src/config/index.ts:llmSources`、`pickField`、`shadowedBy`、`ignoredLlmKeys`、`ENV_ONLY_LLM_KEYS`、`stricterLimit`、`costLimits` | 1 |
| 用户设置读写和校验 | `core/src/settings/index.ts:normalizeLlm`、`updateUserSettings`、`readUserSettings`；`settings/types.ts:isLlmProvider` | 1、4 |
| LLM 错误类型、日志 | `core/src/llm/index.ts:LlmError`、`LlmTruncatedError`、`completeWithLog`、`createLlmClient` | 2 |
| JSON 回复校验和重试 | `core/src/llm/ask-json.ts:askJson`、`parseJsonReply`、`jsonRetryPrompt` | 2 |
| 缓存身份 | `core/src/llm/cache.ts:llmIdentity`、`llmCacheKey` | 2 |
| 客户端创建和首次提示 | `core/src/llm/setup.ts:llmClientFromConfig`、`notifyLlmOnce` | 2、3 |
| token 估算 | `core/src/intent/summary.ts:estimateTokens` | 2、3 |
| 子进程登记和统一结束（只作参考写法） | `core/src/scip/runner.ts` 里的 `runs` 登记表和 `killActiveScipProcesses`。其中 `runProcess` 没有导出，只发 `SIGKILL`、不结束进程组，不能直接用；CLI 另写 `core/src/llm/cli/process.ts`（见 4.4.3），scip 的代码不动 | 2 |
| 原子写文件（临时文件权限） | `core/src/util/atomic-file.ts:writeFileAtomic` | 2 |
| 问答工具定义和执行、结果截断 | `core/src/ask/tools.ts:ASK_TOOLS`、`runAskTool`、`truncateToolResult`、`MAX_TOOL_RESULT_CHARS` | 3 |
| 问答提示词、历史、结束处理 | `core/src/ask/prompt.ts:askSystemPrompt`、`trimHistory`；`core/src/ask/agent.ts:addLinkedRefs`、`messageMeta`、`saveAnswer`、`finish`（抽成两种流程共用，见 4.5） | 3 |
| 问答事件和用量类型 | `core/src/ask/events.ts:AskEvent`、`AskUsage`、`AskErrorCode` | 3 |
| MCP stdio 服务的启停 | `server/src/mcp/server.ts:runMcpStdio`（stdin 结束时关闭）；`server/src/mcp/tool-result.ts` | 3 |
| 打开仓库（配置、数据目录、Store） | `cli/src/commands/workspace.ts:openWorkspace`；`server/src/workspace.ts:openServerWorkspace` | 3 |
| 问答 NDJSON 输出、并发限制 | `server/src/http/routes/chat.ts:streamAnswer`；`server/src/jobs/ask-runs.ts` | 3 |
| 设置接口、来源展示、测试连接框架 | `server/src/http/routes/settings.ts:parseLlmForm`、`resolveUserLlm`、`llmView`、`sourceView`、`testLlm`、`refreshRepoConfig` | 4 |
| 设置对话框、来源文字、测试结果文字 | `web/src/settings/{SettingsDialog.tsx,useSettingsForm.ts,labels.ts}` | 4 |
| MCP 测试的子进程启动方式 | `server/test/helpers/mcp-stdio.mjs`；`server/test/mcp.test.ts` | 3 |
| 集成测试默认跳过的写法 | `core/test/clauve.integration.test.ts`（`describe.skipIf`） | 5 |

不新增外部依赖（MCP 服务用 server 已有的 `@modelcontextprotocol/sdk`）。

## 4. 方案设计

### 4.1 整体思路

在 `LlmClient` 抽象下加两个 CLI 实现，调用方（概览、意图分析）不改流程；问答因为工具循环在 CLI 内部，单独走一条 CLI 问答流程，工具通过一个临时 MCP 服务提供。

```
 ~/.codeinsight/settings.json ─┐
 环境变量 CODEINSIGHT_LLM_*  ──┼─► core/config:llmSources ─► LlmConfig {provider, model, command?, extraEnv?}
 仓库配置（只取 API provider 和 model）┘                         │
                                                   createLlmClient
                       ┌───────────────────────────────┼────────────────────────────┐
              AnthropicClient / OpenAiCompatibleClient       ClaudeCodeClient / OpencodeClient
               （不变）                                   core/src/llm/cli/
                                                         complete()：一次子进程，返回文本或结构化输出
                                                               ▲
          概览 summarize.ts / 意图 intent/index.ts ── askJson(jsonSchema) ┘

 问答：runAsk ─ client 是 CLI？─否→ 现有工具循环（不变）
                         └─是→ cli-agent.ts:runCliAsk
                                 ├─ 临时目录：system.md、mcp.json（权限 600）
                                 ├─ spawn claude -p --output-format stream-json … --mcp-config mcp.json
                                 │        │ （stdio）
                                 │        └─► codeinsight mcp --ask-tools --snapshot <id> …
                                 │              （server/src/mcp/ask-tools.ts：7 个工具 → runAskTool）
                                 └─ stdout 逐行解析 → AskEvent（start/text/tool/tool_done/done/error）→ NDJSON
```

要点：
- 结构化输出：`LlmRequest` 增加可选的 `jsonSchema`，`askJson` 透传；Claude Code 客户端有 schema 时加 `--json-schema`，取结果里的 `structured_output` 序列化成文本交回 `askJson` 的 `parse`；opencode 没有对应参数，取文字后由 `parse` 校验，不合格走 `askJson` 现有的重试。API 客户端忽略 `jsonSchema`，行为不变。
- 每次调用一个子进程，`spawn` 不经 shell；prompt 一律走 stdin，系统提示和 MCP 配置写进临时目录里的文件，参数里只有固定的选项、短的 JSON Schema 和经过校验的模型名，没有大段输入，也没有用户可控的 shell 片段。
- 隔离：在新建的临时空目录里运行；Claude Code 用 `--tools ""`、`--strict-mcp-config`、`--setting-sources ""`、`--permission-mode dontAsk`、`--no-session-persistence`、`--disable-slash-commands`；opencode 用自带的 agent 配置（全部权限拒绝，只允许 codeinsight 的 MCP 工具）、`--standalone`、关闭项目配置和 Claude Code 兼容读取。
- 问答选“为单次问答起一个只含 7 个工具、绑定当前快照的 MCP 服务（stdio）”，不改通用的 `codeinsight mcp`（原因见 4.6）。工具实现直接调用 `runAskTool`，不另写一份。

### 4.2 数据模型

不改数据库表。

**用户设置 `~/.codeinsight/settings.json` 的 `llm`（`core/src/settings/types.ts`）**

```ts
export type ApiLlmProvider = 'anthropic' | 'openai-compatible';
export type CliLlmProvider = 'claude-code' | 'opencode';
export type LlmProvider = ApiLlmProvider | CliLlmProvider;
export const isCliProvider = (v: unknown): v is CliLlmProvider => v === 'claude-code' || v === 'opencode';

export interface UserLlmSettings {
  provider?: LlmProvider;
  baseUrl?: string;   // 只用于 API provider
  model?: string;
  apiKey?: string;    // 只用于 API provider
  command?: string;   // 只用于 CLI provider：可执行文件路径或命令名
  extraEnv?: Record<string, string>; // 只用于 CLI provider
}
```

`normalizeLlm` 的校验（不合格的项记 `user_settings_value_ignored` 后忽略，和现有项一样）：
- `command`：非空字符串，不超过 1024 字符，不含换行和 NUL。
- `extraEnv`：对象；名字匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，最多 32 项；值为字符串，不超过 4096 字符，不含 NUL。名字为 `PATH` 以外的任何值都可以（是用户自己写的）。

**`LlmConfig`（`core/src/config/index.ts`）**

```ts
export interface LlmConfig {
  provider: LlmProvider;
  /** CLI provider 可以为空串：用 CLI 自己的默认模型 */
  model: string;
  baseUrl?: string;
  apiKey?: string;
  command?: string;
  extraEnv?: Record<string, string>;
}
```

**配置来源（`llmSources`）**

| 项 | 用户设置 | 环境变量 | 仓库配置 | 默认 |
| --- | --- | --- | --- | --- |
| provider | 是 | `CODEINSIGHT_LLM_PROVIDER` | 只认 `anthropic`、`openai-compatible`；写 CLI provider 时忽略并给 warning | 无 |
| model | 是 | `CODEINSIGHT_LLM_MODEL`；CLI provider 时只在 provider 也来自环境变量时才用 | API provider 时读；CLI provider 时不读 | anthropic 为 `claude-sonnet-5-5`；CLI 为空（用工具默认） |
| command | 是 | `CODEINSIGHT_LLM_COMMAND` | 否（忽略并给 warning） | `claude` / `opencode`，在 PATH 和常见目录里找 |
| extraEnv | 是 | 无（环境变量本身就会传给子进程） | 否（忽略并给 warning） | 空 |
| baseUrl、apiKey | 同现有；CLI provider 时不用、不显示 | | | |

- `ENV_ONLY_LLM_KEYS` 增加 `command`（对应 `CODEINSIGHT_LLM_COMMAND`）、`extraEnv`（只能在用户设置里写）。仓库配置随被分析的代码一起来，能指定命令路径就能让 CodeInsight 执行仓库里的任意程序，能指定附加环境变量就能改代理地址把请求转走。
- 仓库配置的 `llm.provider` 为 CLI provider 时忽略，warning `config_llm_provider_ignored`：“codeinsight.config.json 里的 llm.provider=claude-code 已忽略：本机 CLI 只能在用户设置或环境变量里选择”。原因：选 CLI provider 会在用户机器上启动本机程序、用用户的订阅额度，不能由仓库决定。
- CLI provider 的 model 只取用户设置，或在 provider 也来自环境变量时取 `CODEINSIGHT_LLM_MODEL`，都没有就为空（用工具默认）。原因：用户在网页里选了 Claude Code 但环境变量里还留着给 API 用的 `CODEINSIGHT_LLM_MODEL=gpt-4o` 时，`--model=gpt-4o` 会直接失败；仓库配置能写 model 的话，还能让 CLI 换用更贵的模型、消耗用户额度。此时环境变量或仓库配置里的 model 不算来源，`model.source` 为 `none`（或 `default`），不记进 `shadowed`。
- model 的校验（所有 provider 统一，CLI 时尤其重要）：不超过 200 字符，匹配 `^[A-Za-z0-9][A-Za-z0-9._:/@#\[\]-]*$`（不能以 `-` 开头，避免被当成选项），传参时用 `--model=<值>` 一个参数。仓库配置给的 model 不合格时忽略并记日志。
- CLI provider 的 `problem`：command 找不到时不在 `loadConfig` 里报错（`loadConfig` 不访问文件系统去找命令），在创建客户端时报 `llm_not_configured`（见 4.4.2）。

**并发**：`costLimits` 的 `overview.concurrency` 默认值按生效的 provider 决定：API 为 4（不变），CLI 为 2（新常量 `DEFAULT_CLI_CONCURRENCY`）。环境变量 `CODEINSIGHT_OVERVIEW_CONCURRENCY` 照旧定上限，仓库配置只能调低。为此 `loadConfig` 先算 `llmSources` 再算 `costLimits`（现在顺序已是如此，只是把 provider 传进去）。

**问答用量**：`AskUsage` 增加可选 `estimated?: true`、`costUsd?: number`。CLI 返回了 usage 时用它（`inputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`），没有时按 `estimateTokens(prompt) / estimateTokens(answer)` 估算并标 `estimated: true`。存进消息 meta，web 暂不显示（现在也不显示用量）。

**缓存身份**：`llmIdentity` 不改算法，CLI 客户端的 `baseUrl` 为 `undefined`，`model` 为空时用 `'default'` 参与计算（即 `sha256('claude-code' + '' + 'default')`）。命令路径不参与：同一个 CLI 换安装位置结果应当一样。代价：工具的默认模型变了，缓存不会失效（见风险）。

### 4.3 接口设计

#### GET /api/settings（改）

`llm` 增加两项，`effective` 增加 `kind`：

```json
{
  "llm": {
    "provider": {"value": "claude-code", "source": "user"},
    "model": {"value": null, "source": "none"},
    "baseUrl": {...}, "apiKey": {...},
    "command": {"value": null, "source": "default", "resolved": "/opt/homebrew/bin/claude"},
    "extraEnv": {"source": "user", "entries": [{"name": "https_proxy", "value": "http://10.4.3.15:3128"}, {"name": "MY_TOKEN", "set": true}]},
    "shadowed": []
  },
  "effective": {"configured": true, "kind": "cli", "provider": "claude-code", "model": "", "problem": null}
}
```

- `command.resolved`：按 4.4.2 找到的绝对路径，找不到为 `null`；只在 provider 是 CLI 时计算。
- `extraEnv.entries`：名字匹配 `/key|token|secret|passw|auth|cookie|credential/i` 的不返回值，只给 `set: true`；URL 形式的值里带用户名密码时，把 `user:pass@` 换成 `***@` 再返回。
- `model.value` 为 `null` 且 provider 是 CLI 时，界面显示“工具默认模型”。

#### POST /api/settings/llm（改）

请求体增加：

```json
{"provider": "claude-code", "model": "", "command": "/opt/homebrew/bin/claude",
 "extraEnv": [{"name": "https_proxy", "value": "http://10.4.3.15:3128"}, {"name": "MY_TOKEN"}]}
```

- `provider` 接受四种。
- CLI provider：`baseUrl`、`apiKey` 必须为空（否则 400 `invalid_param`）。按现有 `resolveUserLlm` 的规则处理：provider 变了不沿用已保存的 key，表单里为空的 `baseUrl` 不保存，所以保存 CLI provider 后用户设置里不再有 key 和服务地址；以后切回 API provider 要重新填 key（或用环境变量），对话框切换 provider 时提示这一点。不另加清除逻辑。`command` 校验同 4.2，额外要求：是绝对路径或不含路径分隔符的命令名。
- `extraEnv` 是完整列表（整体替换）：有 `value` 的用新值；没有 `value` 的项表示沿用已保存的同名值（用于被隐藏的项），已保存里没有这个名字时 400。名字重复 400。
- API provider：`command`、`extraEnv` 不改（保留，切回 CLI 时还在）。
- 日志字段：`provider`、`model`、`command` 只记 basename、`extraEnv` 只记名字列表。

#### POST /api/settings/llm/test（改）

CLI provider 时按 4.4.6 执行，返回：

```json
{"ok": true, "provider": "claude-code", "model": "claude-sonnet-5-5", "command": "/opt/homebrew/bin/claude", "version": "2.1.318 (Claude Code)", "ms": 6120}
{"ok": false, "reason": "not_logged_in", "message": "Not logged in · Please run /login", "ms": 900}
```

`reason` 新增：`command_not_found`、`not_executable`、`version_failed`、`not_logged_in`、`quota`、`rate_limited`、`model_not_found`、`timeout`、`cli_failed`、`bad_response`。`message` 只取 CLI 输出里错误信息的第一行，截到 300 字符。CLI 测试的超时 90s（`app.llmTest` 增加 `cliTimeoutMs`）。

#### GET /api/status（改）

`llm` 改为 `{provider, model, kind: 'api' | 'cli', source: 'user' | 'env' | 'repo'}`（`source` 取 provider 的来源）。没有仓库时同样给出（沿用现有 `loadLlmSources(undefined, …)` 的分支）。

#### codeinsight mcp --ask-tools（新，内部使用）

```
codeinsight mcp --ask-tools --repo <abs> --data-dir <abs> --snapshot <id> [--no-source] [--max-tool-chars N]
```

只注册 7 个问答工具，绑定指定快照，不建索引；快照不存在或不是 ready 时启动失败（退出码 1，stderr 一行原因）。不出现在 `codeinsight --help` 的命令列表里，`codeinsight mcp --help` 末尾注明“--ask-tools 由 ask 内部使用”。

工具：名字、描述、`inputSchema` 直接用 `ASK_TOOLS`（JSON Schema 原样给出，用 SDK 低层 `Server` 的 `ListTools` / `CallTool` 处理器，不转 zod）；`annotations: {readOnlyHint: true, openWorldHint: false}`。返回 `content: [{type: 'text', text}]`，`text` 是 `truncateToolResult(out.content)`，`out.error` 存在时 `isError: true`。累计结果字符超过 `--max-tool-chars` 后，后续调用直接返回现有常量 `TOOL_LIMIT_RESULT` 的文字（从 `agent.ts` 移到 `tools.ts` 导出）。

### 4.4 关键流程

#### 4.4.1 配置（core/settings、core/config）

1. `normalizeLlm` 接受新 provider 和 `command`、`extraEnv`。
2. `llmSources`：provider 来自仓库配置且是 CLI provider 时当作没设，记进 warning；CLI provider 的 model 按 4.2 的规则取（不读仓库配置，环境变量只在 provider 也来自环境变量时用）；`command` 按 用户设置 > `CODEINSIGHT_LLM_COMMAND` > 默认 取值，来源 `default` 时 `value` 为 `undefined`；`extraEnv` 只取用户设置；CLI provider 时 model 缺失不算 problem；CLI provider 时 `baseUrl`、`apiKey` 的来源返回 `none`、不放进 `LlmConfig`。
3. `ignoredLlmKeys` 覆盖 `command`、`extraEnv`、CLI provider。
4. `costLimits` 用 provider 决定并发默认值。
5. `shadowed` 增加 `command`。

#### 4.4.2 找命令（core/llm/cli/command.ts）

`resolveCliCommand(provider, configured?, env)` 是同步函数：`createLlmClient`、`llmClientFromConfig`、`askClient` 都是同步的，找命令也用同步的 `fs.statSync`、`fs.accessSync`，检查的只是几个路径，开销很小，不改这三个函数的签名。
- 配置了绝对路径：检查存在、是普通文件、可执行（`fs.accessSync(X_OK)`），否则报 `command_not_found` / `not_executable`。
- 配置了命令名或没配置（用 `claude` / `opencode`）：按 `env.PATH` 依次找；找不到再查常见安装目录：`~/.local/bin`、`~/.claude/local`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.opencode/bin`、`~/.bun/bin`、`~/.npm-global/bin`。Windows 上只认 `.exe`（找到 `.cmd` 时报 `not_executable`，提示填 `.exe` 路径）。
- 结果按 `(provider, configured, PATH)` 缓存 30 秒，避免每次请求都扫目录。
- `createLlmClient` 对 CLI provider 先找命令，找不到抛 `LlmError('claude-code command not found: …; set the command path in settings or CODEINSIGHT_LLM_COMMAND')`，由 `llmClientFromConfig` 转成 `llm_not_configured` warning（和缺 API key 一样）。

#### 4.4.3 一次子进程调用（core/llm/cli/process.ts）

`runCli(spec, {signal, timeoutMs, idleTimeoutMs, onLine})`：
1. 建临时目录 `mkdtemp(os.tmpdir()/codeinsight-cli-)`，权限 700；需要的文件（`system.md`、`mcp.json`、opencode 的 agent 提示词）用 600 写入。这个目录同时作为子进程的 `cwd`，里面没有任何项目文件。结束（成功、失败、中止）后递归删除。
2. 子进程环境 `buildCliEnv(base, extraEnv, provider, tmp)`，按顺序叠加，后面的覆盖前面的：
   1. `process.env`，去掉 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY`、`CODEINSIGHT_LLM_API_KEY`（否则 Claude Code 会改用 API Key 计费，和“用本机登录状态”不符）；
   2. 仅 Claude Code：用户 Claude Code 设置里的 `env`（读 `$CLAUDE_CONFIG_DIR/settings.json`，没设时 `~/.claude/settings.json`；只取 `env` 对象里的字符串值，文件不存在或不是合法 JSON 时跳过并记日志）。`--setting-sources ""` 下 CLI 自己不读这个文件，不补上的话代理（`https_proxy` 等）、`ANTHROPIC_BASE_URL` 这类网关设置都会丢。这一层里的认证和网关变量（`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 等）是用户为 Claude Code 配的，不去掉；
   3. 附加环境变量 `extraEnv`（用户在 CodeInsight 里明确写的，优先级最高；确实要用 API Key 时写在这里）；
   4. provider 固定项（见 4.4.4、4.4.5），以及 `PWD=<tmp>`：opencode 用 `process.env.PWD ?? cwd` 定工作目录，只改 `cwd` 不够，继承来的 `PWD` 会让它在用户仓库里运行。两种 CLI 都设。
   日志只记第 2、3 层的变量名。
3. `spawn(command, args, {cwd: tmp, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32'})`。prompt 写入 stdin 后关闭 stdin。
4. stdout 按行解析 JSON（单行上限 8 MB、总量上限 64 MB，超过结束进程并报 `bad_response`），每行交给 `onLine`；stderr 只保留最后 16 KB 用于错误分类。
5. 超时：总时长 `timeoutMs`；两次输出之间超过 `idleTimeoutMs` 也算超时。中止：调用方 `signal` 触发或超时时，POSIX 上对进程组发 `SIGTERM`（`process.kill(-pid)`，连同它起的 MCP 子进程），2 秒后仍未退出发 `SIGKILL`；Windows 上 `child.kill()`。
6. 进程登记：模块内 `Set<ChildProcess>`，`killActiveCliProcesses()` 按第 5 步的方式结束全部；serve 关闭、`codeinsight mcp` 结束、CLI 命令收到 SIGINT 时调用。和 `killActiveScipProcesses` 并列：所有现在调用 `killActiveScipProcesses` 的关闭处（`cli/src/commands/serve.ts` 的停止流程、`server/src/mcp/server.ts:stopWork`）都同时调用两个函数，阶段3 里逐处补上并有测试。
   不和 scip 抽成同一个子进程函数：scip 的 `runProcess` 不接 stdin、不解析输出、只需 `SIGKILL`，CLI 要写 stdin、逐行解析、空闲超时、按进程组先 `SIGTERM` 再 `SIGKILL`，两者能共用的只有“登记表 + 全部结束”这一小段；为这一小段改动已经稳定的 scip 运行代码不划算。
7. 退出后返回 `{exitCode, signal, lines 处理结果, stderrTail, ms}`；`spawn` 的 `ENOENT` → `command_not_found`，`EACCES` → `not_executable`。
8. 日志：`llm_cli_start {provider, model, mode: 'complete'|'ask'|'test', command: basename, promptChars}`；`llm_cli_exit {provider, ms, exitCode, signal, inputTokens, outputTokens, costUsd, numTurns}`；失败 `llm_cli_failed {provider, kind, exitCode, stderr: 第一行截到 200 字符}`。不记 prompt、系统提示、工具结果、附加环境变量的值、完整参数（只记选项名列表）。

#### 4.4.4 Claude Code 客户端（core/llm/cli/claude-code.ts）

结构化输出和普通文本（`complete`）：

```
claude -p --output-format json
  --tools "" --strict-mcp-config --setting-sources "" --permission-mode dontAsk
  --no-session-persistence --disable-slash-commands
  --system-prompt-file <tmp>/system.md
  [--json-schema <schema JSON>] [--max-turns 3] [--model=<model>]
stdin：拼好的用户消息
env 固定项：CLAUDE_CODE_MAX_OUTPUT_TOKENS=<req.maxTokens>、CLAUDE_CODE_DISABLE_CLAUDE_MDS=1、
            CLAUDE_CODE_DISABLE_AUTO_MEMORY=1、CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

- 多条消息（`askJson` 重试时是 user / assistant / user）拼成一条：`flattenMessages` 输出“上一次的回复：…（原文）\n\n对上一次回复的意见：…”，放在原始 prompt 后面。
- 结果：读 `type=result` 那一行。`is_error=false` 且有 `structured_output` 时返回 `JSON.stringify(structured_output)`；否则返回 `result` 文本。`subtype=error_max_structured_output_retries` 按“回复不合格”处理（抛 `CliError` kind `bad_response`，askJson 记为请求失败）；`stop_reason` 为 `max_tokens` 或 assistant `error=max_output_tokens` 时抛 `LlmTruncatedError(maxTokens)`。
- `--max-turns 3`：`--json-schema` 由 CLI 内部的结构化输出工具实现，需要至少一轮工具调用。默认带 `--json-schema`（schema 根节点必须是 object，现有的概览和意图请求都满足）；`--tools ""` 下它是否可用在阶段2 第一步用真实 CLI 核实（不可用就把客户端的内部开关 `structuredOutput` 改为 false：不加 `--json-schema`，只靠提示词和 `parse` 校验，流程照常可用）。
- 隔离说明：`--setting-sources ""` 下不读用户级和项目级 CLAUDE.md、hooks、权限设置；`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 是第二层；`--strict-mcp-config` 也排除 claude.ai 账号连接的 MCP 服务。不用 `--safe-mode`（会关掉 MCP，问答用不了）。
- usage：`result.usage` 和 `total_cost_usd` 写进 `llm_cli_exit` 日志；`complete` 的返回值仍是字符串，概览统计照旧按估算（现在 API 客户端也是估算），不改 `OverviewAiStats`。

问答（流式，见 4.4.7）：

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --tools "" --mcp-config <tmp>/mcp.json --strict-mcp-config
  --allowedTools mcp__codeinsight__search_symbols,mcp__codeinsight__get_symbol,…（7 个）
  --permission-mode dontAsk --setting-sources "" --no-session-persistence --disable-slash-commands
  --max-turns <config.ask.maxRounds + 1>
  --system-prompt-file <tmp>/system.md [--model=<model>]
```

`mcp.json`：`{"mcpServers":{"codeinsight":{"type":"stdio","command":<node 绝对路径>,"args":[<cli 入口>, "mcp", "--ask-tools", "--repo", …, "--snapshot", "<id>", …]}}}`。

错误分类（`classifyClaudeError`），按先后顺序取第一个命中的：

| 依据 | kind | 对应 LlmError.status（让 askJson 现有重试生效） | 提示 |
| --- | --- | --- | --- |
| spawn ENOENT / EACCES | `command_not_found` / `not_executable` | — | 检查命令路径 |
| assistant `error` 为 `authentication_failed`、`oauth_org_not_allowed`、`account_on_hold`、`verification_required`、`cloud_credential_error`，或 result 文本以 `Not logged in` 开头 | `not_logged_in` | 401 | 在终端运行 `claude` 登录 |
| `billing_error`，或文本含 `Credit balance` / `usage limit` | `quota` | 402 | 额度已用完 |
| `rate_limit` | `rate_limited` | 429 | 稍后再试 |
| `overloaded`、`server_error` | `server_error` | 503 | 服务繁忙 |
| `model_not_found`、`invalid_request` | `model_not_found` / `invalid_request` | 404 / 400 | 检查模型名 |
| `max_output_tokens` | 抛 `LlmTruncatedError` | — | — |
| 超时 / 中止 | `timeout` / `cancelled` | — | — |
| 退出码非 0 且没有 result 行（如参数错误、`requires --verbose`） | `cli_failed` | — | stderr 第一行 |
| result 行缺失或不是 JSON | `bad_response` | — | — |

`CliError extends LlmError` 增加 `kind`；`status` 只在上表里有值的情况设置，`askJson` 的 429 / 5xx 重试因此对限流和服务繁忙生效，对未登录、额度用完不重试。

#### 4.4.5 opencode 客户端（core/llm/cli/opencode.ts）

```
opencode run --standalone --format json --agent codeinsight --title codeinsight [--model=<provider/model>]
stdin：拼好的用户消息（stdin 不是终端时 run 会读取它；不传消息参数）
env 固定项：
  OPENCODE_CONFIG_CONTENT=<JSON，见下>  PWD=<tmp>
  OPENCODE_DISABLE_PROJECT_CONFIG=1  OPENCODE_DISABLE_CLAUDE_CODE=1  OPENCODE_DISABLE_AUTOUPDATE=1
```

`OPENCODE_CONFIG_CONTENT`（内容固定，只有提示词文件路径、MCP 启动参数和 `steps` 是变量）：

```json
{
  "permission": {"*": "deny"},
  "agent": {"codeinsight": {"mode": "primary", "prompt": "{file:<tmp>/system.md}", "steps": <maxRounds>,
             "permission": {"*": "deny", "codeinsight_*": "allow"}}},
  "mcp": {"codeinsight": {"type": "local", "command": ["<node>", "<cli 入口>", "mcp", "--ask-tools", "…"], "enabled": true},
          "<用户全局配置里的其他 MCP 名字>": {"enabled": false}, …}
}
```

- 结构化输出调用时不带 `mcp`，agent 的 `permission` 只有 `"*": "deny"`，`steps` 为 3。问答时 `steps` = `config.ask.maxRounds`。
- 不加 `--auto` 只会自动拒绝“ask”类的权限请求；配置为 allow 的工具（opencode 默认对多数工具放行，用户全局配置也可能写 `bash: allow`）会直接执行。所以隔离完全依赖上面的权限配置真正生效，权限写法（`"*"` 通配、agent 级 `permission` 覆盖全局、`codeinsight_*`）必须用真实 CLI 核实，核实项见第 7 节“真实 CLI”第 5 项。
- **opencode 的开放条件**：`core/src/llm/cli/opencode.ts` 里有常量 `OPENCODE_PERMISSIONS_VERIFIED`，默认 `false`，只有阶段2 第一步（或阶段5）的权限核实通过后才改为 `true`，并在验证记录里写明核实时的 opencode 版本。为 `false` 时 opencode 不可选：设置对话框里这一项置灰并注明“未验证权限隔离，暂不可用”；`POST /api/settings/llm` 和测试连接返回 400 `provider_unavailable`；环境变量选了 opencode 时 `llmSources` 返回 problem“opencode 尚未通过权限隔离验证”，等同未配置。选“不可选”而不是“可选但标不建议”，因为权限没生效时 opencode 可能在用户机器上执行命令，不能只靠提示。
- 关掉用户全局配置里的 MCP 服务：读用户 opencode 全局配置目录（`$XDG_CONFIG_HOME/opencode`，没设时 `~/.config/opencode`）里的 `opencode.json`、`opencode.jsonc`、`config.json`（JSONC 去掉注释后解析），取出 `mcp` 下的名字，在 `OPENCODE_CONFIG_CONTENT` 里逐个写 `{"enabled": false}`（名字为 `codeinsight` 的被我们的配置覆盖）。文件读不了或解析失败时记日志 `opencode_global_config_unreadable`，照常运行（全局 MCP 工具仍会被权限拒绝，只是服务进程会启动）。
- 插件：`OPENCODE_CONFIG_CONTENT` 里写 `"plugin": []` 能否让全局配置里的插件不加载（数组是覆盖还是合并）在开发时核实；能覆盖就加上；关不掉时保留插件（用户已确认），并在设置对话框选 opencode 时写明“opencode 会运行你全局配置里的插件”。
- 用 `OPENCODE_CONFIG_CONTENT` 而不是 `OPENCODE_CONFIG_DIR`：前者合并在全局配置之后，只覆盖 agent、权限、mcp，用户全局配置里的 provider、模型和登录都保留；后者会让用户配好的 provider 和模型全部失效。全局配置里的 MCP 服务按上一条逐个关掉；插件按上一条处理。用户已确认采用这种做法。
- 会话清理：opencode 每次 `run` 都保存会话。从输出行的 `sessionID` 记下会话 id，进程结束后（成功、失败、中止都算）放进模块内的删除队列 `OpencodeSessionCleaner`。队列在后台一次只跑一个 `opencode session delete --standalone <sessionID>`（`session delete` 一次只接受一个 id；环境变量和 `cwd` 同 run，10 秒超时，失败只记日志 `llm_cli_session_delete_failed`），不阻塞调用结果。这样一次概览的几十次调用不会被删除拖慢，删除在调用间隙和概览结束后陆续完成。删除进程同样用 `runCli` 启动、登记进进程表。没拿到 sessionID（启动即失败）时跳过。`flushOpencodeSessions(timeoutMs)` 等队列清空：serve 关闭、`codeinsight overview/ask/review` 命令结束前调用，最多等 5 秒，没删完的记日志 `opencode_sessions_left {count}`。

- 文本：拼接所有 `type=text` 行的 `part.text`；`type=error` 行或退出码非 0 时按错误处理。
- usage：累加所有 `step_finish` 的 `part.tokens.input`、`output`（`cache.read`、`cache.write` 计入输入）和 `part.cost`。
- 截断：`step_finish.part.reason` 为 `length`，或错误名为 `MessageOutputLengthError` 时抛 `LlmTruncatedError`。
- 错误分类（按 `error.name`）：

| error.name | kind | LlmError.status |
| --- | --- | --- |
| `ProviderAuthError` | `not_logged_in` | 401 |
| `APIError` | 看 `data.statusCode`：401/403 → `not_logged_in`，402 → `quota`，404 → `model_not_found`，429 → `rate_limited`，5xx → `server_error`；其他按 `isRetryable` 决定是否给 503 | 同 statusCode |
| `MessageOutputLengthError` | 抛 `LlmTruncatedError` | — |
| `ContextOverflowError` | `context_overflow`（提示“输入太长”，概览按失败计、问答 failed） | — |
| `ContentFilterError` | `content_filtered` | — |
| `StructuredOutputError` | `bad_response` | — |
| `MessageAbortedError` | `cancelled`（我们自己中止时）或 `cli_failed` | — |
| 其他 | `cli_failed` | — |

  message 取 `error.data.message` 或 `error.message` 第一行。

#### 4.4.6 测试连接（server/http/routes/settings.ts）

CLI provider：
1. 找命令（4.4.2）；失败直接返回 `command_not_found` / `not_executable`。
2. `<command> --version`（10s 超时，同样的环境变量和临时目录）；失败 `version_failed`。
3. Claude Code：`claude auth status --json`（10s），`loggedIn=false` → `not_logged_in`（不发模型请求）。这时如果 4.4.3 第 2 步读到的用户设置里有 `apiKeyHelper`，message 改为“检测到 apiKeyHelper：CodeInsight 不执行它，请在终端运行 claude 登录，或把 key 写进附加环境变量 ANTHROPIC_API_KEY”。注意：附加环境变量或用户设置 `env` 里有 `ANTHROPIC_API_KEY` 时 `loggedIn` 可能为 false 但仍可调用，此时不在这一步返回失败，交给第 4 步。opencode 没有等价的只读检查，跳过这一步。
4. 一次最小调用：`complete({system: '', messages: [{role: 'user', content: 'Reply with OK.'}], maxTokens: 16})`，走正式客户端的全部参数和隔离设置；收到回复就算成功，`model` 取 Claude 的 `system/init.model` 或 opencode 的 `step_start` 里的模型（拿不到时用配置值或“工具默认模型”）。
5. 错误按 4.4.4 / 4.4.5 的 kind 映射成 `reason`。

界面在“测试连接”按钮旁说明：“会真实调用一次本机 CLI，消耗少量额度”。

#### 4.4.7 CLI 问答（core/ask/cli-agent.ts）

`runAsk` 开头判断 `isCliClient(opts.client)`，是则交给 `runCliAsk`，共用 `startRun` 里取 sendSource、概览、历史、超时信号的部分和 `finish`（保存消息、发 done/error、日志）。`AskOptions` 增加 `toolServer?: {command: string; args: string[]}`：CLI 问答必须有，没有时以 `internal_error` 结束（调用方漏传）。

1. 准备：系统提示 = `askSystemPrompt(...)` + 一段 CLI 说明（“只能用 codeinsight 提供的工具；工具名前缀不同但含义一样”）写入 `system.md`；用户消息 = 历史（`trimHistory` 结果按“用户：… / 回答：…”拼成文字）+ 当前问题；`mcp.json` 里的服务参数 = `toolServer.args` + `--repo`、`--data-dir`、`--snapshot <id>`、`--no-source`（sendSource 为 false 时）、`--max-tool-chars <config.ask.maxToolChars>`。
2. 启动 4.4.4 的流式命令（opencode 用 4.4.5 加 MCP 的配置），超时用现有 `ASK_TIMEOUT_MS`，空闲超时 120s。
3. 逐行转换（Claude Code）：
   - `stream_event` 且 `event.type=content_block_delta`、`delta.type=text_delta` → `text` 事件（新一条 assistant 消息开始时，若已有文字且不以换行结尾，先补 `\n\n`，和现有 `chatRound` 一致）。
   - `assistant` 消息里的 `tool_use` 块 → `tool` 事件，`name` 去掉 `mcp__codeinsight__` 前缀（网页的 `tool-labels.ts` 按原名显示，不用改），`args` 为 `input`；记下 `id → name`。
   - `user` 消息里的 `tool_result` 块 → `tool_done` 事件：`resultChars` 为结果文本长度；文本以 `error: <code>:` 开头且 code 属于 `AskToolError` 时带 `error`；累计到 `toolCalls`（ms 用 tool_use 到 tool_result 的时间差）和 `toolChars`。
   - 没有收到任何 `stream_event` 增量（CLI 不支持 partial messages 时）时，用 `assistant` 消息里的 `text` 块补发 `text` 事件，不会丢字。
   - `result`：`is_error=false` → done（`status: 'done'`）；`subtype=error_max_turns` → `limited`、`reason: 'max_rounds'`；`toolChars` 超过上限 → `limited`、`reason: 'max_tool_chars'`；`stop_reason=max_tokens` → `limited`、`reason: 'max_tokens'`；其他错误按 4.4.4 分类后 `failed`、`code: 'llm_failed'`，message 带分类后的提示（如“本机 Claude Code 未登录，请在终端运行 claude 登录”）。
   - 结束后如果回答为空且是 limited，补 `LIMIT_EMPTY_ANSWER`（和现有 `finalRound` 一致）。
4. opencode：`text` 行整段作为一次 `text` 事件；`tool_use` 行（工具名去掉 `codeinsight_` 前缀）同时发 `tool` 和 `tool_done`；`step_finish` 累加用量；轮数上限用 agent 配置的 `steps` = `config.ask.maxRounds`，步数用完结束时（最后一个 `step_finish` 的 `reason` 不是正常结束）标 `limited`、`max_rounds`。
5. refs：工具在另一个进程里执行，父进程拿不到 `SymbolRow`。结束时照常调用 `addLinkedRefs`（按回答里的 `sym:` 链接查当前快照），网页的符号链接仍然可用；另外从工具结果文本每行开头的符号 id（`symbolLine` 的格式）补查一次，让 refs 和 API 流程尽量一致。
6. 用户中止、超时、客户端断开：沿用 `signal`，子进程按 4.4.3 结束（连同 MCP 子进程）；结束原因判断沿用 `failure()` 里“先看 userSignal、再看 timeout”的顺序。

#### 4.4.8 问答工具 MCP 服务（server/mcp/ask-tools.ts、cli/commands/mcp.ts）

1. `codeinsight mcp --ask-tools …`：用 `openWorkspace(repo, dataDir)` 打开（SQLite 是 WAL 模式，和 serve 进程同时读没问题）；取 `--snapshot` 指定的快照和当前概览，组成 `AskToolContext`（`sendSource` 按 `--no-source`）。
2. `runAskToolsMcpStdio(ctx, {maxToolChars, maxCalls?})`：低层 `Server` + `StdioServerTransport`；`ListTools` 返回 `ASK_TOOLS`；`CallTool` 调 `runAskTool(ctx, name, args)`，计数和累计字符；stdin 结束时关闭，关闭 Store 后退出。
3. 日志写 stderr（和现有 MCP 一致），每次调用记 `ask_tool {tool, args 截到 200 字符, resultChars, ms, error}`，与 API 流程同名同字段。
4. serve 和 `codeinsight ask` 构造 `toolServer`：`{command: process.execPath, args: [<cli 入口 main.js 的绝对路径>, 'mcp', '--ask-tools']}`，入口路径由 `cli/src/main.ts` 所在位置得到（`fileURLToPath(import.meta.url)`），serve 通过 `startHttpServer` 的新选项 `askToolServer` 传给 server，`routes/chat.ts:streamAnswer` 放进 `runAsk` 的参数。

#### 4.4.9 网页

- `SettingsDialog`：provider 下拉加“Claude Code（本机）”“opencode（本机）”两项；选 CLI 时隐藏服务地址和 API Key，显示：
  - 命令路径输入框，placeholder 为找到的路径（`command.resolved`）或“未找到，请填写可执行文件路径”；
  - 模型输入框，placeholder “留空使用工具默认模型”；opencode 时说明格式 `provider/model`；
  - 附加环境变量：多行“名字 = 值”编辑表格（增删行），隐藏值的项显示“已设置，留空不修改”；
  - 从 API 切到 CLI 时，若用户设置里有 API Key，提示“保存后不再保留已保存的 API Key 和服务地址，以后切回需要重新填写”（现有 `resolveUserLlm` 不跨 provider 沿用 key）。
  - 测试连接按钮旁的说明文字（4.4.6）；测试结果显示版本和实际模型。
- `labels.ts`：新的 `reason` 中文说明（如 `not_logged_in`：“本机 CLI 未登录，请在终端运行 claude（或 opencode auth login）登录”）。
- 状态栏和问答提示、概览生成弹窗：模型为空时显示“默认模型”；provider 为 CLI 时加“（本机 CLI，使用你的订阅/账号额度）”。新增 `web/src/settings/model-label.ts:llmLabel(provider, model)` 三处共用。
- `web/src/api/types.ts`：`LlmProvider` 四种；设置、status 的新字段。

### 4.5 公共逻辑

| 公共逻辑 | 位置 | 负责阶段 | 使用阶段 |
| --- | --- | --- | --- |
| `isCliProvider`、扩展后的 `LlmProvider` | `core/src/settings/types.ts` | 阶段1 | 2、3、4 |
| 模型名、命令路径、附加环境变量的校验函数（设置文件、接口共用） | `core/src/settings/validate.ts`（新建，`normalizeLlm` 和 server 的 `parseLlmForm` 都调用） | 阶段1 | 1、4 |
| 找命令 `resolveCliCommand` | `core/src/llm/cli/command.ts` | 阶段2 | 2、4 |
| 子进程运行、环境变量构造、临时目录、进程登记 `runCli`、`buildCliEnv`、`withCliTempDir`、`killActiveCliProcesses` | `core/src/llm/cli/process.ts` | 阶段2 | 2、3、4 |
| 两种 CLI 的参数构造和输出解析、错误分类（`claudeArgs`、`parseClaudeLine`、`classifyClaudeError`、`opencodeConfig`、`parseOpencodeLine`、`classifyOpencodeError`）、`CliError` | `core/src/llm/cli/{claude-code,opencode,errors}.ts` | 阶段2 | 2、3、4 |
| 多条消息拼成一条 `flattenMessages` | `core/src/llm/cli/prompt.ts` | 阶段2 | 2、3 |
| `TOOL_LIMIT_RESULT` 移到 `ask/tools.ts` 导出；`agent.ts` 里 `startRun` 的共用部分和 `finish` 拆成两种流程都能调用的函数 | `core/src/ask/{tools,agent}.ts` | 阶段3 | 3 |
| 假 CLI 脚本 | `core/test/helpers/{fake-claude,fake-opencode}.mjs`（按环境变量 `FAKE_CLI_SCENARIO` 输出预设内容，把 argv、stdin、cwd、`PWD`、关键环境变量记录到 `FAKE_CLI_RECORD` 文件） | 阶段2 | 2、3、4、web e2e |
| 网页的模型显示 `llmLabel` | `web/src/settings/model-label.ts` | 阶段4 | 4 |

### 4.6 备选方案

- **把 7 个问答工具加进现有的 `codeinsight mcp`**：没采用。通用 MCP 服务按“当前工作区”取快照（`ensureWorkspaceSnapshot`，必要时现场建索引），而问答要绑定提问时的那个快照；通用服务里还有 `review_changes` 等工具，加 `--allowedTools` 也只能靠 CLI 的权限配置挡住，不如服务本身只有这 7 个工具；`sendSource` 和工具结果上限是每个问题的设置，通用服务没有地方传。单次问答的专用服务启动参数里就带了快照、源码开关和上限，进程随问答结束。
- **在 serve 进程里开一个本地 HTTP MCP 端点（工具在父进程执行）**：工具调用能直接复用 `executeCall`（事件、refs 和 API 流程完全一样），也不用再起一个 Node 进程。没采用：`codeinsight ask` 命令也要临时监听端口；要给每个问答发一次性 token 并防止本机其他进程连入；opencode 远程 MCP 带自定义请求头的支持没能核实。stdio 子进程的代价是多一个 Node 进程（约 0.3 秒启动）和 refs 要补查，可以接受。
- **CLI 问答也用现有的工具循环（每轮起一个 CLI 进程，让它只输出“要调用哪个工具”的 JSON）**：每轮都要重新启动 CLI 并重发全部上下文，慢且贵，工具调用格式也不可靠。没采用。
- **Claude Code 用 `--bare` 隔离**：最干净，但不读 OAuth 登录，订阅用户不能用，违背“不需要 API Key”。没采用。
- **用 `--input-format stream-json` 把多条历史消息按原样发给 Claude Code**：输入流只能是用户消息，不能放之前的 assistant 回复，仍要拼文字。没采用，统一用 `flattenMessages`。

## 5. 兼容性与上线

- 用户设置文件版本不变（新增可选字段）；旧版本 CodeInsight 读到新 provider 时 `normalizeLlm` 会忽略它（记日志），回到“未配置”。
- API provider 的请求、日志、缓存 key 都不变；已有测试不改期望值。
- `LlmProvider` 类型扩大，web 和 server 里按 provider 分支的地方（`defaultBaseUrl`、`PROVIDER_KEY_ENV`、`testResultText` 等）都要处理新值；TypeScript 的穷尽检查能找出遗漏。
- CLI 版本兼容：启动参数只用 4.4.4、4.4.5 列出的选项。CLI 升级后选项失效时，退出码非 0、stderr 有“unknown option”，归为 `cli_failed`，提示里带 stderr 第一行和“请升级/反馈”。最低版本：Claude Code 2.1.x、opencode 2.x（测试连接显示版本，不做强制检查）。
- 回滚：设置里换回 API provider 即可；不涉及数据迁移。

## 6. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| `--tools ""` 同时关掉了 `--json-schema` 依赖的结构化输出工具 | 结构化输出失败 | 客户端内部开关 `structuredOutput`，真实检查不通过时关掉，只靠提示词 + `parse` 校验（askJson 已有重试）；阶段2 第一步验证 |
| 隔离参数没有完全生效（CLAUDE.md、用户级 MCP、hooks、插件仍被加载） | 用户的个人指令混进回答；hooks 可能执行命令 | 多层叠加：临时空目录（`cwd` 和 `PWD`）+ `--setting-sources ""` + `--strict-mcp-config` + `--tools ""` + `dontAsk` + 禁用 CLAUDE.md 的环境变量；阶段5 用 `system/init` 输出检查 `tools` 只有 7 个 MCP 工具、`mcp_servers` 只有 codeinsight；`--safe-mode` 会关掉 MCP，不作为备用 |
| opencode 权限配置不生效，或会加载用户全局配置里的插件（插件能执行代码） | 可能执行命令、改文件 | 权限核实通过前 opencode 不可选（`OPENCODE_PERMISSIONS_VERIFIED`）；全局 MCP 服务逐个关掉；插件尝试用 `"plugin": []` 覆盖，覆盖不了时保留插件并在设置对话框里写明“opencode 会运行你全局配置里的插件” |
| opencode `--format json` 无文档，版本间可能变化 | 解析失败 | 解析只依赖 `type`、`part.text`、`part.tool`、`part.state`、`part.tokens`；未知行忽略；拿不到任何文字时报 `bad_response` 并在日志记 CLI 版本 |
| 默认模型变化不会让概览缓存失效 | 换了默认模型后仍用旧说明 | 设置对话框提示“需要固定结果时请填写模型”；用户可以删 `llm-cache` 重生成 |
| Claude Code 会改写用户的 `~/.claude.json`（记录临时目录项目） | 用户配置文件里多出临时目录的条目 | 可接受（`--no-session-persistence` 下不保存会话）；记在说明里 |
| 环境里有 `ANTHROPIC_API_KEY` 时 Claude Code 改走 API 计费 | 用户以为用的是订阅 | 子进程环境去掉这类变量（4.4.3 第 2 步） |
| 子进程或其 MCP 子进程残留 | 占资源、持有 Store | 进程组结束 + 登记表 + MCP 服务 stdin 结束即退出；测试检查无残留进程 |
| GUI 启动的 serve 的 PATH 不全 | 找不到命令 | 常见目录兜底，设置里显示找到的路径，可以手填 |
| opencode 会话删除跟不上或被打断 | 用户的 opencode 会话列表里留下少量 CodeInsight 的会话；每次删除要启动一个 opencode 进程（约 1–2 秒） | 后台队列一次一个、不阻塞调用；命令和 serve 结束前最多等 5 秒；serve 被强制结束时可能留下少量会话，日志记数量；会话标题统一为 `codeinsight`（`--title`），用户可以手动识别删除 |
| 并发 2 时概览很慢（每次调用要启动 CLI，几秒） | 体验 | 允许用 `CODEINSIGHT_OVERVIEW_CONCURRENCY` 调高；进度条已有 |
| 订阅额度被概览大量消耗 | 用户额度不够用 | 沿用生成前的估算和二次确认；CLI provider 时提示文字说明“使用你的订阅额度” |
| 附加环境变量里有密钥 | 泄露 | 文件权限 600；接口不回传敏感名字的值；日志只记名字 |

## 7. 测试方案

**假 CLI**：`core/test/helpers/fake-claude.mjs`、`fake-opencode.mjs`（`#!/usr/bin/env node`，测试前 `chmod 755`；Windows 上相关用例跳过）。按 `FAKE_CLI_SCENARIO` 输出：`ok-text`、`ok-structured`、`stream`（带 stream_event 增量、tool_use、tool_result、result）、`not-logged-in`（照实测的未登录输出）、`billing`、`rate-limit`、`overloaded`、`truncated`、`max-turns`、`bad-json`、`exit-2-stderr`、`hang`（不输出、不退出）、`slow-then-hang`、`spawn-grandchild`（起一个子进程后挂住，用于检查进程组结束）、`mcp`（读 `--mcp-config` 或 `OPENCODE_CONFIG_CONTENT`，用 `@modelcontextprotocol/sdk` 的 Client 连上 stdio 服务，按脚本调用工具，把真实结果写成 tool_use / tool_result 行；放在 `server/test/helpers/`，因为 SDK 是 server 的依赖）。每次运行把 argv、stdin、cwd、`PWD` 的值、环境变量名列表写进 `FAKE_CLI_RECORD`。假 opencode 的 `session delete` 子命令也记录下来。

**core 单测（阶段1、2、3）**
- 配置：四种 provider 的来源和优先级；仓库配置写 CLI provider、`command`、`extraEnv` 时忽略并给 warning；`CODEINSIGHT_LLM_COMMAND`；CLI 时 model 可空、并发默认 2；CLI provider 时仓库配置的 `llm.model` 不用、provider 来自用户设置时 `CODEINSIGHT_LLM_MODEL` 不用、provider 也来自环境变量时用、`CODEINSIGHT_OVERVIEW_CONCURRENCY` 仍生效；model 以 `-` 开头、带空格、换行时被拒；设置文件里不合格的 `command`、`extraEnv` 项被忽略。
- 找命令：PATH 命中、常见目录兜底、绝对路径不存在、不可执行、Windows `.cmd`（模拟平台）。
- 参数：Claude 结构化调用、问答调用的完整参数列表（逐项比较）；用户输入（prompt、历史、模型名、附加环境变量的值）不出现在 argv 里，除 `--model=` 以外；prompt 从 stdin 收到；cwd 和 `PWD` 都是临时目录且结束后被删除；`ANTHROPIC_API_KEY` 等不在子进程环境里、附加环境变量在；临时 `CLAUDE_CONFIG_DIR` 下的 `settings.json` 的 `env`（含 `https_proxy`、`ANTHROPIC_BASE_URL`）进入子进程环境，附加环境变量覆盖同名项，文件损坏时跳过；opencode 调用结束后执行了 `session delete <sessionID>`（成功、失败、中止三种情况）；`system.md` 权限 600。
- 输出：结构化成功（返回 `structured_output` 的 JSON）、文本成功、`flattenMessages`、askJson 不合格重试一次时第二次 stdin 里带上一次回复和意见。
- 错误分类：表格里每一类各一条，含未登录（实测格式）、额度、限流后 askJson 等待重试、截断、`requires --verbose` 类的参数错误、spawn ENOENT。
- 超时和中止：`hang` 在 `timeoutMs` 后结束并报 `timeout`；`signal` 中止在 3 秒内结束；`spawn-grandchild` 中止后孙进程也不在了（`process.kill(pid, 0)` 抛 ESRCH）；`killActiveCliProcesses` 结束全部。
- 缓存身份：CLI 空模型和指定模型的 `llmIdentity` 不同，和 API provider 不同。
- 概览、意图分析用假 CLI 跑通，请求带了对应的 JSON Schema（读 `FAKE_CLI_RECORD`）；API provider 的请求体里没有 schema 字段。
- CLI 问答（假 `claude` 的 `stream` 场景，不起真实 MCP）：事件顺序 start → text… → tool → tool_done → text… → done；工具名去掉前缀；`error: not_found:` 结果映射成 `tool_done.error`；`max-turns` → limited；用户中止 → cancelled 且保存了已收到的文字；超时 → timeout；没有 partial 增量时由 assistant 文本补发；用量来自 result，缺失时 `estimated: true`。

**server 单测（阶段3、4）**
- `mcp --ask-tools` 服务：用 SDK Client 连接，`listTools` 恰好 7 个、schema 与 `ASK_TOOLS` 相同；调用 `search_symbols`、`read_source` 的结果和直接 `runAskTool` 相同；`--no-source` 时 `read_source` 不返回代码；累计超过 `--max-tool-chars` 后返回限制文字；不存在的快照启动失败。
- MCP 工具调用路径：假 `claude`（`mcp` 场景）+ 真实 ask-tools 服务，`POST /api/chat/sessions/:id/messages` 返回的 NDJSON 里有对应的 `tool` / `tool_done` 和最终 done，消息被保存，refs 里有工具结果中出现的符号；结束后没有残留的 MCP 进程。
- 设置接口：保存 CLI provider 时清掉 apiKey 和 baseUrl；CLI provider 带 apiKey 时 400；`extraEnv` 整体替换、沿用隐藏值、名字非法和重复 400；GET 不返回敏感名字的值、URL 里的密码被替换；仓库配置里的 command 不出现在来源里。
- opencode 未验证时（`OPENCODE_PERMISSIONS_VERIFIED=false`，测试里可注入）：保存和测试连接返回 400 `provider_unavailable`，环境变量选 opencode 时 status 显示未配置和原因。
- 测试连接：假 CLI 的成功、`command_not_found`、`version_failed`、`not_logged_in`（`auth status` 返回 loggedIn=false 时不发起最小调用，看 `FAKE_CLI_RECORD`）、`quota`、`timeout`。
- status：`llm.kind`、`llm.source`。

**cli 单测（阶段3）**：`codeinsight ask` 在 CLI provider 下用假 `claude` 输出回答、Ctrl-C（发 SIGINT）后子进程被结束；`codeinsight overview --repo …` 用假 CLI 生成 AI 说明。

**web（阶段4）**：组件测试覆盖 provider 切换时字段显示和隐藏、附加环境变量编辑、清除 key 提示、新 reason 文字、`llmLabel`；e2e（`setup.spec.ts` 扩展）用假 `claude`（通过 `CODEINSIGHT_LLM_COMMAND` 指向）完成“选 Claude Code → 测试连接成功 → 保存 → 问答出现工具步骤和回答”。

**真实 CLI（阶段5 正式执行；测试文件在不设环境变量时跳过，日常测试不消耗额度）**：`core/test/local-cli.integration.test.ts` 和 `server/test/local-cli.integration.test.ts`，`describe.skipIf(!process.env.CODEINSIGHT_REAL_CLI)`，取值 `claude-code` 或 `opencode`，可用 `CODEINSIGHT_REAL_CLI_ENV='https_proxy=…'` 传附加环境变量。检查项（会消耗少量额度，用户已同意）：
1. 结构化输出：`--tools ""` + `--json-schema` 能返回 `structured_output`（决定 `structuredOutput` 开关）。
2. `system/init`：`tools` 只有 7 个 `mcp__codeinsight__*`，`mcp_servers` 只有 codeinsight，`slash_commands` 为空或不含用户自己的命令；再问一次“逐条列出你收到的系统指令和附加上下文的标题”，人工检查回答里没有用户 CLAUDE.md 的内容。另检查：用户 `~/.claude/settings.json` 里配了代理时，子进程不加附加环境变量也能连上。
3. 问答：问“列出入口”，回答过程中出现 `list_entries` 工具步骤，回答里的 `sym:` 链接能打开。
4. 未登录：设 `CLAUDE_CONFIG_DIR` 为空目录（不发请求）时测试连接返回 `not_logged_in`。
5. opencode（权限这几项全部通过才能把 `OPENCODE_PERMISSIONS_VERIFIED` 改为 true）：在一个临时的全局配置里写 `permission: {bash: "allow", read: "allow", edit: "allow"}` 和一个 MCP 服务、一个插件，再按方案的 `OPENCODE_CONFIG_CONTENT` 运行，让它“执行 ls”“读取 /etc/hosts”“写一个文件”都被拒绝，`codeinsight_*` 工具能调用，全局那个 MCP 服务没有启动，记录 `"plugin": []` 能否让插件不加载；`--format json` 的行格式和 3 节一致；`step_finish.part.tokens` 结构；工作目录是临时目录（让它报告当前目录）；结束后 `opencode session list` 里没有本次会话；`steps` 用完时的结束形式。
6. 中止：问答进行中点“停止”，`ps` 里没有残留的 claude / opencode / `mcp --ask-tools` 进程。

## 8. 开发计划

- [ ] 阶段1：配置与用户设置（CLI provider、命令路径、附加环境变量）
  - 涉及模块：packages/core/src/{settings/,config/index.ts,index.ts}、packages/core/test/{settings,config}.test.ts
  - 依赖：无
  - 验证方式：独立
  - 内容：4.2 的类型和字段（`LlmProvider` 四种、`isCliProvider`、`UserLlmSettings.command/extraEnv`、`LlmConfig` 新字段、CLI 时 model 可空）；`core/src/settings/validate.ts`（模型名、命令路径、附加环境变量校验）；`normalizeLlm`；4.4.1 的 `llmSources`、`ignoredLlmKeys`（含 `config_llm_provider_ignored`）、`CODEINSIGHT_LLM_COMMAND`、`shadowed`；`costLimits` 按 provider 定并发默认值；`AskUsage` 的 `estimated`、`costUsd`；core 导出新类型和函数
  - 完成标准：`pnpm -r build`、`pnpm lint` 通过；`pnpm --filter @codeinsight/core test` 通过，已有 config、settings 测试不改期望值；第 7 节“配置”各项有用例；`pnpm -r test` 通过（server、web 因类型扩大需要的最小改动只限穷尽分支）

- [ ] 阶段2：CLI 调用层与结构化输出（概览、审查可用）
  - 涉及模块：packages/core/src/llm/{cli/,index.ts,ask-json.ts,setup.ts,cache.ts}、packages/core/src/overview/{summarize-input.ts,summarize.ts}、packages/core/src/intent/、packages/core/test/（新增 llm-cli.test.ts、helpers/fake-claude.mjs、helpers/fake-opencode.mjs）
  - 依赖：阶段1
  - 验证方式：独立
  - 内容：第一步（真实调用，用户已同意消耗少量额度；阶段2 和阶段5 合计每个 CLI 约 20 次请求以内）：用真实 `claude`、`opencode` 各做几次最小调用，核实 Claude Code 的 `--tools ""` 下 `--json-schema` 是否返回 `structured_output`、`--system-prompt-file`、`--max-turns`、`stream-json` 各行格式、`dontAsk` + `--allowedTools` 下 MCP 工具可用、`~/.claude/settings.json` 的 `env` 由我们并入后能连通；opencode 的 stdin、`PWD` 决定的工作目录、权限写法、`steps`、`session delete`；结果写进本阶段验证记录，和方案不符的先改方案再开发。之后：4.4.2 找命令；4.4.3 `runCli`、`buildCliEnv`、临时目录、进程组结束、`killActiveCliProcesses`、日志；4.4.4 / 4.4.5 两个客户端的 `complete`、`OPENCODE_PERMISSIONS_VERIFIED` 和 opencode 的不可用处理、关闭用户全局 MCP、会话删除队列 `OpencodeSessionCleaner`、参数构造、输出解析、错误分类、`CliError`、`flattenMessages`；`LlmRequest.jsonSchema` 和 `askJson` 透传；概览各类请求和意图分析的 JSON Schema（与现有 `validate` 对应，放在请求定义旁边）；`createLlmClient` 按 provider 分派、找不到命令转 `llm_not_configured`；`llmIdentity` 空模型用 `default`；`notifyLlmOnce` 的提示文字带“本机 CLI”；假 CLI 脚本
  - 完成标准：`pnpm -r build`、`pnpm lint` 通过；`pnpm --filter @codeinsight/core test` 通过，已有 llm、ask-json、overview、intent 测试不改期望值；第 7 节 core 单测里“找命令”“参数”“输出”“错误分类”“超时和中止”“缓存身份”“概览、意图分析用假 CLI 跑通”各项有用例；中止用例结束后 `pgrep -f fake-claude` 无输出

- [ ] 阶段3：问答走 MCP（ask-tools 服务、CLI 问答流式转 NDJSON）
  - 涉及模块：packages/core/src/ask/{agent.ts,cli-agent.ts,tools.ts}、packages/server/src/mcp/ask-tools.ts、packages/server/src/{index.ts,http/server.ts,http/context.ts,http/routes/chat.ts}、packages/cli/src/commands/{mcp.ts,ask.ts,serve.ts}、packages/core/test/、packages/server/test/（新增 ask-tools-mcp.test.ts、helpers/ask-tools-mcp.mjs、helpers/fake-claude-mcp.mjs）、packages/cli/test/
  - 依赖：阶段2
  - 验证方式：独立
  - 内容：4.3 的 `codeinsight mcp --ask-tools`；4.4.8 `runAskToolsMcpStdio`（低层 Server、直接用 `ASK_TOOLS` 和 `runAskTool`、只读标注、调用计数和字符上限）；4.4.7 `runCliAsk`（两种 CLI 的事件转换、limited / failed / cancelled、refs 补查、用量）；`agent.ts` 拆出共用部分、`TOOL_LIMIT_RESULT` 移到 `tools.ts`；`AskOptions.toolServer`；serve 的 `askToolServer` 选项、`chat.ts` 传入；`codeinsight ask` 传入并在 SIGINT 时结束子进程；所有调用 `killActiveScipProcesses` 的关闭处同时调用 `killActiveCliProcesses`，serve 关闭和命令结束前调用 `flushOpencodeSessions`；`askClient` 对 CLI 客户端不再要求 `chat`
  - 完成标准：`pnpm -r build`、`pnpm lint` 通过；`pnpm --filter @codeinsight/core test`、`pnpm --filter @codeinsight/server test`、`pnpm --filter @codeinsight/cli test` 通过，已有 ask、chat-api、mcp 测试不改期望值；第 7 节 core“CLI 问答”、server“mcp --ask-tools 服务”“MCP 工具调用路径”、cli 各项有用例；跑完 `pgrep -f 'fake-claude|--ask-tools'` 无输出

- [ ] 阶段4：设置接口、测试连接、status 与网页
  - 涉及模块：packages/server/src/http/routes/{settings,status}.ts、packages/server/src/http/context.ts、packages/server/test/、packages/web/src/{settings/,api/types.ts,app/StatusBar.tsx,chat/notice.ts,chat/ChatPage.tsx,overview/GenerateDialog.tsx}、packages/web/test/、packages/web/e2e/{setup.spec.ts,helpers/cli.ts}
  - 依赖：阶段1、阶段2、阶段3（e2e 要走问答；两个阶段都改 `server/src/http/context.ts`）
  - 验证方式：独立
  - 内容：4.3 的 GET / POST `/api/settings`、`/api/settings/llm/test`、`/api/status` 改动（`parseLlmForm` 用阶段1的校验函数；CLI provider 按现有 `resolveUserLlm` 规则不沿用别的 provider 的 key；`extraEnv` 隐藏和沿用；`command.resolved`）；4.4.6 测试连接（版本、`auth status`、最小调用、新 reason、`cliTimeoutMs`）；4.4.9 网页（设置对话框（opencode 未验证时置灰并说明）、额度说明、`llmLabel`、新 reason 文字、类型）；e2e 用假 `claude` 走通“设置 → 测试连接 → 保存 → 问答”
  - 完成标准：`pnpm -r build`、`pnpm lint` 通过；`pnpm --filter @codeinsight/server test`、`pnpm --filter @codeinsight/web test` 通过，已有 settings-api、web 设置组件测试不改期望值；`pnpm --filter @codeinsight/web test:e2e` 通过（含新增的 CLI 设置用例）；第 7 节 server“设置接口”“测试连接”“status”、web 各项有用例；手工打开 `codeinsight serve`，选 Claude Code 时看不到服务地址和 API Key 输入框

- [ ] 阶段5：真实 CLI 集成检查
  - 涉及模块：packages/core/test/local-cli.integration.test.ts、packages/server/test/local-cli.integration.test.ts，以及按检查结果调整的 packages/core/src/llm/cli/
  - 依赖：阶段3、阶段4
  - 验证方式：独立
  - 内容：第 7 节“真实 CLI”1–6 项写成默认跳过的集成测试（`CODEINSIGHT_REAL_CLI=claude-code|opencode`）（日常 `pnpm -r test` 跳过，不消耗额度）；本阶段对两个 CLI 各真实跑一遍（用户已同意，每个 CLI 与阶段2 合计约 20 次请求以内）；结果与阶段2 第一步不一致时调整 `structuredOutput` 开关、opencode 权限写法、`OPENCODE_PERMISSIONS_VERIFIED` 等；把结论写进本阶段验证记录
  - 完成标准：不设环境变量时 `pnpm -r test` 里这两个文件全部跳过；`CODEINSIGHT_REAL_CLI=claude-code pnpm --filter @codeinsight/core test -- local-cli` 和 `CODEINSIGHT_REAL_CLI=claude-code pnpm --filter @codeinsight/server test -- local-cli` 通过（opencode 同样）；检查后 `pgrep -f 'claude -p|opencode run|--ask-tools'` 无输出；第 7 节“真实 CLI”1–6 项的结果写进验证记录

## 9. 待确认问题

无
