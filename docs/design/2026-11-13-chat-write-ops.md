# CodeInsight 问答页布局优化与对话中写文件、建 PR 技术方案

开发状态: DONE
方案评审: 通过（2026-11-13）
需求来源: 2026-11-13 东凯（经 Simon 转达）：问答页左侧会话列表固定并可收起、对话区改成聊天布局；问答对话里支持创建 PR、在本机工作空间或项目仓库中写文件，写操作要限定可写目录
作者: dongkai@zbyte-inc.com　　日期: 2026-11-13

## 1. 背景与目标

问答页现在是普通网页：消息越多页面越长，输入框被推到最下面，左侧会话列表跟着页面滚走。问答助手只能查代码，用户让它改文件或建 PR 时会拒绝。

做完后要达到：

- 问答页是聊天布局：左侧会话列表固定、可单独滚动、可收起；消息区单独滚动，输入框固定在底部，新消息自动滚到底。
- 用户在网页问答里让助手改文件或建 PR，助手给出具体修改，回答下面显示一张“待确认”卡片（文件列表和改动对比），用户点“写入”或“创建 PR”后才真正执行。
- 写入范围和 Claude Code 一样在启动时确定：只能写当前打开的仓库，以及启动 serve 时用 `--add-dir` 指定的目录；网页上不能改写入范围。`.git`、`.codeinsight` 这类目录、指向外面的符号链接、系统和配置目录一律不能写。
- API 和本机 Claude Code 两种模型来源都能用。opencode 目前在设置里不能选（`llm/cli/opencode.ts:15` 的 `OPENCODE_PERMISSIONS_VERIFIED = false`），工具同样接上，启用后可用。

## 2. 范围

做：

1. 问答页布局：固定会话列表、聊天布局、自动滚到底、会话列表收起并记住状态。
2. 两个新问答工具：`propose_file_changes`（写文件）、`propose_pull_request`（建 PR）。工具只生成“待确认的修改”，不直接写。只在网页问答（有会话）里提供，`codeinsight ask` 命令行问答不提供。
3. 待确认修改的保存、查看对比、执行、忽略、失败重试。
4. `codeinsight serve --add-dir <目录>`（可多次）：启动时指定仓库以外可写的目录。
5. 网页上的确认卡片。

不做：

- 删除、重命名文件（PR 的 `working_tree` 来源里已有的删除除外，见 4.5）。
- 助手执行命令、跑测试、不经确认直接写文件。
- 让助手读取仓库以外的文件；因此仓库以外的可写目录只能新建文件，不能覆盖已有文件。
- 合并 PR、评论、改已有 PR；GitHub 以外的平台。

## 3. 现状分析

### 3.1 问答页布局

- `web/src/chat/ChatPage.tsx:78-116`：`.chat-page` 是两列 grid，左边 `SessionList`（`<aside class="panel chat-sessions">`），右边 `.chat-main` 里依次是提示、错误、`Conversation`（`.chat-messages`）、`Composer`（`.chat-composer`）。
- `styles.css:177-194`：`.chat-page { align-items:start }`；`.chat-sessions` 只有 `max-height: calc(100vh - 140px); overflow:auto`，不固定；`.chat-messages` 没有高度限制；`.chat-composer` 在普通文档流里。整页靠浏览器滚动，chat 目录里没有自动滚到底的逻辑。
- `app/App.tsx:43-85`：`header` 是 `position: sticky; top:0`，状态栏会换行，高度不固定；header 下面可能有切换仓库提示、banner。现有代码把头部高度写成经验值（`.source-panel` 用 110px / 90px，`.chat-sessions` 用 140px）。
- localStorage 写法：`graph/show-models.tsx:4-31`（`codeinsight.graph.showModels`，读写包 try/catch）。

### 3.2 为什么现在会拒绝写文件、建 PR

根本原因是**工具白名单**：问答助手只有 7 个只读工具，没有能写东西的工具。系统提示（`core/ask/prompt.ts:16-24`）没有“禁止写文件 / 建 PR”的话，只是把角色定为“回答代码问题”，要求说法以工具结果为依据，所以模型会回答“做不到”。

| 路径 | 限制来源 |
| --- | --- |
| API（anthropic / openai-compatible），`core/ask/agent.ts` | 每轮只传 `ASK_TOOLS`（`tools.ts:24-63`，注释写明“都只读……不能写文件、执行命令、访问网络”），没有别的权限层 |
| 本机 Claude Code，`core/ask/cli-agent.ts` + `llm/cli/claude-code.ts` | `--tools ''` 关掉全部内置工具；`--allowedTools` 只列 7 个 `mcp__codeinsight__*`；`--permission-mode dontAsk`；在临时目录运行；MCP 服务只暴露 `ASK_TOOLS` 并标 `readOnlyHint` |
| opencode，`llm/cli/opencode.ts` | 配置里 `permission: {'*':'deny', 'codeinsight_*':'allow'}`，在临时目录运行；目前不能选 |

改法是**加两个新工具**，不放开 CLI 的内置工具或权限：放开 Claude Code 的 Write / Bash 等于让它在本机任意执行命令、写任意路径，范围没法限定。新工具也不直接写盘，只生成待确认的修改，用户在页面上确认后由 serve 执行。三条路径的隔离参数不变，只在白名单里加两个工具名。

### 3.3 其他相关现状

- 输出上限：`agent.ts:25` 的 `ASK_MAX_TOKENS = 4096`，API 路径作为 `maxTokens`，Claude Code 路径通过 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`。工具参数也算在输出里，一次工具调用的参数大约只能放 12 KB 文本。
- 工具定义：`ToolSpec` 加 `HANDLERS` 里的同名函数，由 `runAskTool`（`tools.ts:92-105`）执行，错误转成 `error: <code>: …`。错误码是 `events.ts:15` 的 `AskToolError`；CLI 路径按 `cli-agent.ts:28` 写死的 `TOOL_ERRORS` 识别错误码。
- 工具调用事件：API 路径在 `agent.ts` 的 `executeCall` 里，CLI 路径在 `cli-agent.ts` 的 `toolStarted / toolFinished`（参数来自 stream-json 的 `tool_use.input`），都会发 `{type:'tool', name, args}`，并把 `args` 存进回答 `meta.toolCalls`（`chat_messages.meta`），会话详情接口原样返回，网页在没有中文说明时显示 `JSON.stringify(args)`（`answer.ts`、`tool-labels.ts:26`）。
- 回答保存：问答结束时 `agent.ts` 的 `finish()` 调 `saveAnswer`（`core/store/chats.ts`）。
- 快照：`files.content_hash` 是文件内容的 sha1（`snapshot/source.ts:92`）。读源码工具只能读快照清单里的文件（`checkListed`）。
- git 工具 `core/git/index.ts` 只有只读操作（`runGit`、`diffWorking`、`listWorkingFiles`、`readFileAtCommit`、`commitMessages`、`resolveRef` 等）；全仓没有用到 `gh`。
- 服务只监听 127.0.0.1；token 换 HttpOnly + SameSite=Strict cookie；所有请求检查 Host / Origin；仓库相关请求带 `X-CodeInsight-Repo`，不一致返回 409。设置接口都是 POST、`needsRepo:false`。
- 设置文件：`settings/index.ts` 的 `serialize()`、`changedFields()` 按字段白名单写出；`CODEINSIGHT_HOME` 可以改设置目录。
- 新表要加进 `store/schema.ts` 的 `EXTRA_TABLES`，`store/db.ts:67-75` 的 `ensureExtraTables` 才会给已有数据库补表。
- 没有让问答暂停等用户输入的机制；CLI 路径是 `dontAsk`，没法交互。
- web 包没有 `lint` 脚本，lint 在根目录跑 `pnpm lint`。
- JetBrains 插件的 `web/src/bridge.ts` 只有 `openFile`，内嵌浏览器里点外部链接不一定能打开。

### 可复用的已有代码

- `core/ask/tools.ts` 的 `ToolSpec`、`HANDLERS`、`runAskTool`；`tool-args.ts` 的参数解析。
- `core/util/paths.ts` 的 `checkRelativePath`、`resolveInside`、`PathNotAllowedError`；`core/util/relative-path.ts` 的 `isSafeRelativePath`（web 也能用）。写入路径检查在它们基础上扩展。
- `core/util/atomic-file.ts` 的 `writeFileAtomic`（已从 `core/index.ts` 导出），扩展为可指定文件权限。
- `core/settings` 的 `realPathOr`、读写和原子写。
- `core/git/index.ts` 的 `runGit`、`listWorkingFiles`（未跟踪文件已排除被忽略的文件）、`readFileAtCommit`、`commitMessages`、`resolveRef`。
- 快照 `files.content_hash`：判断模型读到的内容是不是磁盘上的当前内容。
- `server/mcp/ask-tools.ts`：按工具列表暴露 MCP 工具。
- `web/settings/Modal.tsx`、`graph/show-models.tsx` 的 localStorage 写法。

## 4. 方案设计

### 4.1 整体思路

```
用户：把 X 改成 Y 并建个 PR
  └─ 助手查代码 → 调 propose_pull_request(title, body, edits…)
        └─ 工具检查参数和路径、确认修改能应用 → 返回“已生成待确认的修改，等用户确认”
  └─ 问答正常结束 → 保存回答时一起保存成功的待确认修改（chat_proposals）→ 发 proposal 事件
网页：回答下面显示确认卡片（文件列表、改动对比）
  └─ 用户点“创建 PR” → POST /api/chat/proposals/12/apply
        └─ serve 再检查一遍 → 用 git 底层命令在临时索引里生成提交（不检出、不跑钩子）→ push → gh pr create → 卡片显示 PR 链接
```

要点：

- **工具不写盘**：执行只在用户点按钮后由 serve 做。Claude Code 的隔离参数全部保留。
- **不暂停问答**：工具立即返回，问答照常结束；确认可以在之后任意时间做。
- **两次检查**：工具执行时检查一次（模型能马上改正），用户点执行时 serve 按最新设置再检查一次，以执行时为准。
- **建 PR 不碰工作区、不执行仓库里的脚本**：用临时索引文件和 `hash-object / update-index / write-tree / commit-tree` 生成提交，再推送这个提交。不检出文件，所以不会触发 checkout、commit 钩子，也不会执行模型写进新分支的钩子脚本。
- **修改用“查找并替换”**：输出上限只有 4096 token，修改已有文件不能给完整内容。

### 4.2 数据模型

#### 写入范围（启动时确定，`core/ask/write-roots.ts`）

写入根目录只有两类，都在 serve 启动时确定，运行中不能通过网页或接口修改：

- `repo`：当前打开的仓库根目录。网页切换仓库时跟着变（每个仓库的待确认修改存在各自的数据库里）；插件以 `--lock-repo` 启动时固定不变。
- `dir1`、`dir2` …：`codeinsight serve --add-dir <目录>` 指定的目录，按参数顺序编号，最多 10 个。只能新建文件。

`--add-dir` 的检查（启动时取真实路径后检查，不合法直接报错退出）：

- 必须是已存在的目录，去重。
- 不能是根目录、用户主目录本身，不能在这些目录下面（按真实路径前缀比较，不区分大小写）：`/System`、`/usr`、`/bin`、`/sbin`、`/etc`、`/var`、`/private`、`/opt`、`/Library`、`/Applications`、`/dev`、`/proc`、`/boot`；Windows 的 `Windows`、`Program Files*`、`ProgramData`；主目录下的 `Library` 和所有以 `.` 开头的目录（`~/.ssh`、`~/.config`、`~/.codeinsight` 等）。
- 自身和每一级上级目录都不能是 `.git` 目录、`CODEINSIGHT_HOME`、名为 `.codeinsight` 的目录。
- 系统目录名单和主目录作为参数传入检查函数（默认取本机实际值），测试里可以用临时目录。

不新增用户设置字段。

#### 新表 `chat_proposals`（仓库数据库，加进 `EXTRA_TABLES`）

```sql
CREATE TABLE IF NOT EXISTS chat_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- 'files' | 'pull_request'
  payload TEXT NOT NULL,         -- JSON，见下
  status TEXT NOT NULL,          -- 'pending' | 'applying' | 'applied' | 'dismissed' | 'failed'
  progress TEXT,                 -- JSON：建 PR 已完成的步骤（提交号、是否已推送）
  result TEXT,                   -- JSON：写入的文件 / PR 链接 / 失败原因
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_proposals_message ON chat_proposals(message_id);
```

另加 `pid INTEGER` 列：执行中的 serve 进程号，用于多进程判断（见 4.4）。

`payload`（保存时已经把修改算好，执行时用的就是用户看到的内容）：

```ts
/** 一个文件修改后的结果。edits 来源的修改后内容很小（受工具参数上限限制），直接存文本 */
interface ProposedFile {
  path: string;                 // 相对写入根目录，统一用 /
  isNew: boolean;
  content: string;              // 修改后的完整内容（保留原文件的 BOM 和换行符）
  baseSha1: string | null;      // 生成时磁盘上（PR 为起点提交上）的内容 sha1，新文件为 null
  staleSnapshot?: boolean;      // 模型读到的快照内容和磁盘内容不一致；快照里没有该文件时不设，卡片显示“未读取过原文”
  sensitive?: boolean;          // codeinsight.config.json 等会改变本工具行为的文件，卡片上特别标出
}

interface FilesProposal { root: 'repo' | `dir${number}`; rootPath: string; summary: string; files: ProposedFile[] }

interface PullRequestProposal {
  title: string; body: string;
  base: string;                 // 目标分支
  branch: string;               // 新分支名
  source: 'edits' | 'working_tree';
  startCommit: string;          // 起点提交：edits 为 origin/<base>，working_tree 为 HEAD
  files?: ProposedFile[];       // edits 来源
  tree?: string;                // working_tree 来源：保存时生成的 tree 编号（见 4.5），由 refs/codeinsight/proposals/<id> 引用，防止被 git gc 清理
  changes?: { path: string; status: 'A' | 'M' | 'D' | 'T' }[];   // working_tree 来源的文件列表，供卡片显示
  unpushedCommits?: string[];   // working_tree 来源时 HEAD 上未推送到 origin/<base> 的提交（一行摘要）
}
```

限制：一次最多 20 个文件；单次工具参数合计约 6 000 字符（中文约 3 000 字，按 4096 token 输出上限估算），超过时工具返回错误，提示模型拆成多次调用。`working_tree` 来源不受这个限制（内容不经模型）。

`refs/codeinsight/proposals/<id>` 在修改执行完或被忽略后删除。它不在 `refs/heads`、`refs/tags` 下，普通 push 不会推送；只有 `git push --mirror` 会带上，这一点写进设置页说明。

### 4.3 工具设计

两个工具只在 `AskRun` 带 `sessionId` 且由 serve 发起时提供（`runAsk` 新参数 `writeTools`）；CLI 路径通过 MCP 服务的新开关 `--write-tools` 控制，同时把 `--add-dir` 目录用 `--writable-dir` 传给 MCP 子进程。

#### propose_file_changes

```
参数：
  root?: 'repo' | 'dir1' | 'dir2' …    不传为当前仓库；可写目录用别名，不把绝对路径发给模型
  summary: string
  files: [{
    path: string,                       相对 root
    create?: string,                    新文件的完整内容（文件必须不存在）
    edits?: [{ old: string, new: string }]   修改已有文件：old 必须在文件里恰好出现一次，按顺序替换
  }]                                    create 和 edits 恰好给一个；仓库以外只允许 create
返回：“Proposal ready: <n> files. The user must review and apply it in the UI; nothing has been written yet.”
```

#### propose_pull_request

```
参数：
  title: string, body: string
  base?: string        默认远程默认分支
  branch?: string      默认 codeinsight/<标题里的英文和数字转成短横线>-<yyyyMMddHHmm>，转出来为空时用 codeinsight/pr-<yyyyMMddHHmm>
  files?: 同上（root 固定为仓库），修改基于 origin/<base> 上的内容
  fromWorkingTree?: { paths?: string[] }   改为用工作区当前的未提交改动（含未跟踪、未忽略的文件），paths 为空表示全部
  files 和 fromWorkingTree 恰好给一个
返回：同上
```

#### 路径检查（`core/ask/write-scope.ts`，工具和执行共用，基于 `util/paths.ts` 扩展）

1. 用 `checkRelativePath` / `isSafeRelativePath` 拒绝绝对路径、`..`、空段、`\0`；Windows 上拒绝 `:`、保留设备名（`CON`、`NUL` 等）、`~` 短文件名写法。
2. 每一段先做 Unicode NFC、去掉零宽字符、去掉末尾的点和空格、转小写，再和禁止名单比较：`.git`、`.codeinsight`、`node_modules`、`.husky`、`.githooks`。
3. 取 `root/path` 最近的已存在祖先目录的真实路径，必须在 `root` 的真实路径之内，且不在当前配置实际使用的数据目录（`dataDir` 的真实路径，可能被 `CODEINSIGHT_DATA_DIR` 或配置改名）和 `CODEINSIGHT_HOME` 之内；目标已存在且是符号链接时拒绝。
4. `root` 必须是当前仓库根，或启动时 `--add-dir` 指定的目录（比较真实路径）。
5. 不合法返回新错误码 `write_not_allowed` 和原因（`AskToolError`、`cli-agent.ts` 的 `TOOL_ERRORS`、网页错误说明都加上）。

写入时（4.4）建完父目录、改名之前，再取一次父目录真实路径检查。

#### 生成修改（`core/ask/build-proposal.ts`，工具和保存共用）

`buildProposal(args, ctx)` 按参数算出 payload，不写盘：

- 按路径检查；读磁盘上的当前内容，按顺序应用 `edits`（`old` 找不到或不止一处时报 `invalid_args` 并说明是哪一处）。
- 编码：按 UTF-8 解码后再编码和原字节不一致的文件（GBK、二进制等）拒绝修改；保留 BOM；匹配 `old` 前把模型给的换行统一成文件原来的换行符。
- 比较快照的 `content_hash` 和磁盘内容的 sha1，不一致时提示模型“文件在建索引后改过”，并记 `staleSnapshot`。
- PR 的 `edits` 来源按本地已有的 `origin/<base>` 上的内容应用修改，不联网；`working_tree` 来源只检查 `paths` 和名字。

#### 工具执行时和保存时各做什么

- **工具执行时**（API 路径在 serve 进程内，CLI 路径在 MCP 子进程里）：调一次 `buildProposal` 做检查和预演，把能发现的错误立即告诉模型；不联网，不写对象库。MCP 子进程不需要联网和 git 凭据。
- **core 记下原始参数**：API 路径在 `executeCall`、CLI 路径在 `toolStarted` 时，把写工具的原始参数（未去内容）放进 `AskRun` 内存里的 `pendingWrites`；收到成功的工具结果（`tool_done` 没有 error）后标为成功。原始参数不进事件、不进 `toolCalls`。
- **保存时**（serve 进程）：问答结束且状态是 `done` 或 `limited` 时，先异步对每个成功的写调用重新执行 `buildProposal`（PR 的 `edits` 来源此时先 `git fetch origin <base>`，`working_tree` 来源此时生成 tree，见 4.5），再在同步事务里同时插入回答和修改记录。重新生成失败的（比如期间文件被改、fetch 失败）也保存，状态直接为 `failed`，原因写清楚，卡片上显示，用户可以重新问。
- 状态是 `failed` 或 `cancelled` 时不保存修改。

#### 关闭“发送源码”时

`sendSource=false` 时模型读不到原文，`edits` 一定匹配不上：此时 `propose_file_changes` 只接受 `create`，`propose_pull_request` 只接受 `fromWorkingTree`，提示里写明，并和现有 `NO_SOURCE_RULE` 一致。

#### 事件和记录里不带文件内容

发 `tool` 事件和存 `toolCalls` 前，用 `redactWriteArgs` 把两个写工具参数里的 `create`、`edits`、`body` 换成字数，只留 `path` 等。

#### 系统提示补充（`core/ask/prompt.ts`，只在提供写工具时加）

```
- You cannot change files yourself. When the user asks to change or create files, call propose_file_changes;
  for a pull request, call propose_pull_request. Edit existing files with exact old/new snippets copied from
  read_source, without the line-number prefix. The user reviews and applies proposals in the UI.
  Never say a change was made or a PR exists.
- Writable locations: repo (this repository); dir1 (<目录名>), … (new files only). Other paths are rejected.
```

只发目录名（最后一段），不发绝对路径。

### 4.4 保存、接口和执行

#### 保存

保存流程见 4.3“工具执行时和保存时各做什么”。保存后发 `{ type: 'proposal', proposal: ProposalView }` 事件。`ProposalView` = `{ id, kind, status, summary/title, root 名称, base, branch, files: [{ path, isNew, deleted, staleSnapshot, sensitive }], unpushedCommits, result }`，不含文件内容。

#### 接口（都走现有 token、Host/Origin 和 `X-CodeInsight-Repo` 检查）

| 接口 | 说明 |
| --- | --- |
| `GET /api/chat/sessions/:id`（改） | 每条回答带 `proposals: ProposalView[]` |
| `GET /api/chat/proposals/:id/diff`（新） | 每个文件的统一 diff。旧内容：`files` 为磁盘当前内容，PR 为起点提交里的内容；新内容为 payload 里的 content；`working_tree` 来源用 `git diff <startCommit> <tree>`。文本对比用 `git diff --no-index` 对两个临时文件生成（有差异时退出码为 1，按正常处理，不走 `runGit` 的出错逻辑）。磁盘内容的哈希和 `baseSha1` 不同时带 `changedSinceProposal: true` |
| `POST /api/chat/proposals/:id/apply`（新） | 请求体 `{ force?: boolean }`。只接受 `pending` 和 `failed`；先改为 `applying`，同一条同时只能执行一次。返回更新后的 `ProposalView` |
| `POST /api/chat/proposals/:id/dismiss`（新） | `pending / failed → dismissed` |
| `GET /api/status`（改） | 返回写入范围：`{ repo: true, dirs: [目录名…] }`，网页用来显示说明 |

执行写文件（`files`）：

1. 再检查一遍路径和 root（root 为 `repo` 时必须仍是生成修改时的仓库，切换过仓库的直接失败；目录被删掉的直接失败）。
2. 已有文件：磁盘内容 sha1 和 `baseSha1` 不同时，返回 409 `file_changed_since_proposal`，前端提示后可以带 `force` 重发（只限仓库内的文件）。
3. 新文件：一律排他创建（临时文件写好后用 `link()` 到目标，目标已存在就失败），不会覆盖期间被创建的文件；目标已存在时返回 409 `file_exists`，仓库内的可以由用户选择 `force` 覆盖，仓库以外的不接受 `force`。
4. 已有文件用 `writeFileAtomic` 写入（扩展为保留原文件权限）；父目录不存在时创建；改名或 `link` 之前再取一次父目录真实路径检查。
5. 记 `applied` 和写入的文件；任何一步失败记 `failed` 和原因。部分文件已写入时，结果里列出哪些已写入。

执行时把 `pid` 记为当前进程号。serve 启动时只把 `applying` 且 `pid` 对应进程已不存在（复用 `core/store/process.ts` 的 `isProcessAlive`）的记录改成 `failed`（原因“执行中断”），不动其他 serve 进程正在执行的记录。

日志：`proposal_saved`、`proposal_apply`（id、kind、root 名称或 branch、文件数、结果），不记文件内容。

### 4.5 建 PR（`server/proposals/pull-request.ts`）

所有 git / gh 命令用 `execFile`、cwd 为仓库根，不经 shell，每步 60 秒超时；环境变量加 `GIT_TERMINAL_PROMPT=0`、`GH_PROMPT_DISABLED=1`；ssh 命令先取用户已有的 `GIT_SSH_COMMAND` 环境变量或 `git config core.sshCommand`，在后面追加 `-o BatchMode=yes`，都没有时用 `ssh -o BatchMode=yes`，不覆盖用户自己的 ssh 配置。需要输入密码时直接失败而不是卡住。serve 退出时结束正在跑的子进程。

**名字检查**（工具执行和执行时都做）：`base`、`branch` 用 `git check-ref-format --branch` 检查，并拒绝以 `-` 开头、含空白或控制字符的值；git 命令在用户给的值前加 `--end-of-options`；pathspec 一律加 `--literal-pathspecs`。

**生成时（问答结束保存时，在 serve 进程里）**

1. 确认有 `origin`；默认分支先取本地 `refs/remotes/origin/HEAD`，取不到再用 `git ls-remote --symref origin HEAD`，再用 `gh repo view --json defaultBranchRef`；工具执行时不联网，只取本地，取不到时提示模型传 `base`。
2. `git fetch origin --end-of-options <base>`，得到起点（会更新用户仓库里的 `origin/<base>`）。
3. `edits` 来源：起点为 `origin/<base>`，按起点提交里的文件内容应用修改（`readFileAtCommit`），结果存进 payload。
4. `working_tree` 来源：起点为 `HEAD`，用临时索引生成 tree：`GIT_INDEX_FILE=<临时文件> git read-tree HEAD`，再 `git add -A --literal-pathspecs -- <paths>`（`paths` 为空时用 `.`），`git write-tree`。`git add` 不跑钩子，跳过被忽略的文件，符号链接按链接本身记录（不会读出链接指向的仓库外文件），可执行位、删除、重命名都由 git 自己处理。用 `git update-ref refs/codeinsight/proposals/<id> <tree>` 防止 tree 被清理（保存事务提交后建立），用 `git diff --name-status --no-renames HEAD <tree>` 得到文件列表。同时用 `commitMessages` 列出 `origin/<base>..HEAD` 的提交。

**执行时**

1. 前置检查：`gh` 在 PATH 里；从 origin 地址解析 `owner/name` 和主机名，`gh auth status --hostname <主机>` 通过（origin 用 ssh 别名等解析不出主机时，用 `gh repo view` 取，仍取不到就失败并提示）。
2. 生成提交（不碰工作区）：
   - `edits` 来源：临时索引 `GIT_INDEX_FILE=<临时目录>/index`，`git read-tree <起点>`；每个文件 `git hash-object -w --stdin` 写入内容，`git update-index --add --cacheinfo <mode>,<blob>,<path>`（已有文件沿用起点提交里的 mode，新文件 100644）；`git write-tree` 得到 tree。
   - `working_tree` 来源：直接用保存时的 tree。
   - `git commit-tree <tree> -p <起点> -m <title>`（作者用用户的 git 配置）得到提交号，记进 `progress`。
3. 推送：远程分支已存在时，内容就是 `progress` 里的提交则跳过推送（重试的情况），否则失败（分支名冲突）；不存在时 `git push --no-verify origin <提交号>:refs/heads/<branch>`，记进 `progress`。
4. `gh pr create --repo <owner/name> --base=<base> --head=<branch> --title=<title> --body-file <临时文件>`（值用 `=` 连写，以 `-` 开头的标题不会被当成参数），正文末尾加“由 CodeInsight 问答生成”；从输出里取 PR 链接。PR 已存在时（重试）用 `gh pr view` 取链接。
5. 记 `applied` 和链接；失败记 `failed` 和原因，`progress` 保留，重试时从断点继续。
6. 清理临时目录；执行成功或被忽略后删除 `refs/codeinsight/proposals/<id>`。

不创建本地分支、不检出文件，所以用户当前分支、工作区、未提交改动都不变；也不会执行仓库里或模型写的钩子脚本。`commit-tree` 按用户的 `commit.gpgsign` 配置签名，需要输入密码时会失败并提示。

### 4.6 网页

#### 问答页布局（`app/App.tsx`、`chat/ChatPage.tsx`、`SessionList.tsx`、`styles.css`）

- `App` 用 `ResizeObserver` 量 header（含提示条）的实际高度，写到根元素的 CSS 变量 `--header-h`；`.source-panel` 的 110px / 90px 也改用它。
- `.chat-page` 高度为 `calc(100vh - var(--header-h) - 24px)`，`overflow: hidden`，页面不再整体滚动。
- 左栏 `.chat-sessions` 高度占满，自身 `overflow:auto`。
- 右栏 `.chat-main` 改纵向 flex：提示和错误在上面；`.chat-messages` 为 `flex:1; overflow:auto`；`.chat-composer` 在最下面。
- 自动滚到底：发送新问题时直接滚到底；流式输出和新卡片出现时，用户在底部附近（80px 内）才跟着滚；往上翻看时不打断，右下角显示“回到底部”按钮。
- 收起会话列表：列表顶部加收起按钮；收起后左栏变成 36px 宽的竖条（展开、新建会话两个按钮），对话区占满宽度。状态存 `localStorage` 的 `codeinsight.chat.sidebarCollapsed`。

#### 确认卡片（`chat/ProposalCard.tsx`、`chat/DiffView.tsx`）

- 显示在对应回答下面：标题（“修改 3 个文件 · 写入 当前仓库” / “创建 PR：标题 → main，新分支 codeinsight/…”）、文件列表（新建 / 修改 / 删除；`staleSnapshot` 的文件标黄“助手读到的是建索引时的旧内容”）。
- 点开看 diff：`GET …/diff` 按需加载；`DiffView` 自己写，按行着色（`+` 绿、`-` 红、`@@` 灰），不引入 diff 库。
- 按钮：“写入” / “创建 PR”、“忽略”；执行中按钮变灰。`working_tree` 来源有未推送的提交时，黄色提示列出这些提交会一起进 PR。
- 结果：已写入（列出文件）；已创建 PR（链接 + “复制链接”按钮，插件里外部链接打不开时可以复制）；失败（原因 + “重试”）；已忽略。
- 返回 `file_changed_since_proposal` 时提示并提供“仍然写入”。
- `tool-labels.ts` 增加两个工具的中文说明；`ToolSteps` 标题按实际情况写（如“查询了 5 次代码索引，生成了 1 个待确认修改”）。

#### 设置

问答页输入框上方显示一行写入范围说明：“可写：当前仓库” 或 “可写：当前仓库、notes（仅新建）”，并提示写入范围由启动参数 `--add-dir` 决定。

### 4.7 公共逻辑

| 逻辑 | 位置 | 由哪个阶段先做 |
| --- | --- | --- |
| 写入路径检查 | `core/ask/write-scope.ts`（扩展 `util/paths.ts`） | 阶段2 |
| 写入根目录和 `--add-dir` 检查 | `core/ask/write-roots.ts` | 阶段2 |
| 应用 edits（含编码、BOM、换行处理） | `core/ask/apply-edits.ts` | 阶段2 |
| 生成修改 `buildProposal` | `core/ask/build-proposal.ts` | 阶段2 做检查和预演，阶段3 补保存时的部分，阶段5 补 PR 部分 |
| 写工具参数去掉内容 | `core/ask/redact.ts` | 阶段2 |
| 保留权限的原子写 | 扩展 `util/atomic-file.ts` | 阶段3 |
| git 写对象、临时索引、update-ref、推送、ls-remote | `core/git/write.ts`（基于 `runGit`） | 阶段5 |

### 4.8 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 放开 Claude Code 内置 Write / Bash，用 `--add-dir` 限定目录 | Bash 能执行任意命令，目录限制管不住；API 路径用不了 |
| 工具直接写盘 | 模型可能写错或被代码里的文字诱导；推送难以撤回 |
| 问答中途暂停等确认 | CLI 是非交互模式；还要处理 5 分钟总时长和无输出超时 |
| 建 PR 用 `git worktree` 检出再提交 | 会跑 checkout / commit 钩子，钩子可能来自模型写的文件；大仓库检出慢 |
| 让模型给完整文件内容 | 受 4096 token 输出上限限制，稍大的文件就被截断 |
| 调大 `ASK_MAX_TOKENS` | 所有问答都变慢变贵，大文件仍然不够 |

## 5. 兼容性与上线

- `chat_proposals` 加进 `EXTRA_TABLES`，旧数据库打开时自动补表。旧版本程序打开新数据库不读这张表。
- 不改设置文件格式。插件启动 serve 时不带 `--add-dir`，插件里只能写当前仓库。
- 不带 `--add-dir` 时只能写当前仓库；没装 `gh` 或没登录时写文件照常，建 PR 失败并提示原因。
- 插件里的问答页同样生效；PR 链接提供“复制链接”。

## 6. 风险

| 风险 | 应对 |
| --- | --- |
| 代码或文档里的文字诱导模型生成恶意修改 | 所有写操作都要用户看过 diff 后确认；禁止写 `.git`、钩子目录、配置目录；建 PR 不执行任何钩子 |
| 模型基于旧快照内容生成修改 | edits 按磁盘当前内容应用，找不到原文就失败；快照和磁盘不一致时卡片标出；执行前再比哈希 |
| 路径检查被大小写、Unicode、符号链接跳过 | 4.3 的规范化和真实路径检查；写前再查一次父目录 |
| 分支名、路径被当成 git 参数 | `check-ref-format`、`--end-of-options`、`--literal-pathspecs` |
| PR 带上本地未推送的提交 | 卡片列出；`edits` 来源从 `origin/<base>` 开始 |
| 推送或 gh 卡住 | 非交互环境变量、每步超时、失败可重试 |
| 保存 PR 修改时 `git fetch` 会更新用户仓库的 `origin/<base>`，并需要联网和凭据 | 只在 serve 进程里做，失败时卡片为 failed 并写明原因；不改本地分支 |
| 多个 serve 进程共用一个仓库数据库 | 记录执行进程号，只恢复进程已退出的记录 |
| 模型修改 `codeinsight.config.json` 改掉发送源码、数据目录等设置 | 卡片上把这类文件标为需要特别注意 |
| 跨站请求触发写操作 | 沿用 SameSite=Strict cookie 和 Host / Origin 检查 |

## 7. 测试方案

- core 单测（`core/test/write-scope.test.ts`、`write-roots.test.ts`、`ask-write-tools.test.ts`）：
  - 路径：`..`、绝对路径、`.GIT/hooks`、`.git.`、零宽字符、`node_modules`、`.husky`、符号链接指向外面、目标是符号链接、改名后的数据目录、root 别名不存在、Windows 风格路径。
  - edits 编码：GBK 文件被拒绝、BOM 保留、CRLF 文件里用 LF 的 old 能匹配且写回仍是 CRLF。
  - 关闭发送源码时只接受 create / fromWorkingTree。
  - `--add-dir` 检查：根目录、主目录、`/etc`（真实路径 `/private/etc`）、`~/.ssh`、`CODEINSIGHT_HOME`、仓库的 `.git` 子目录、不存在、重复、超过 10 个；切换仓库后 `repo` 跟着变。
  - 工具：edits 找不到 / 多处匹配 / 按顺序应用；仓库外只能新建；`files` 与 `fromWorkingTree` 互斥；大小上限；`branch`、`base` 以 `-` 开头或格式不对被拒绝；中文标题的默认分支名。
  - 事件和 `toolCalls` 里不含 `create` / `edits` 内容。
  - 不带 sessionId 的问答没有写工具。
- server 单测（`server/test/chat-proposals.test.ts`、`pull-request.test.ts`）：
  - 假模型（API 路径）和 fake-claude（CLI 路径）调用写工具后，回答保存时生成记录、发 `proposal` 事件；问答被取消时不生成。
  - apply：写入成功并保留可执行权限；路径不合法；文件被改过返回 409、force 后写入；`applying` 中重复 apply 返回 409；dismiss；新文件在确认前被创建时返回 `file_exists`、仓库外不接受 force；启动时只把进程已退出的 `applying` 改为 `failed`；状态为 `limited` 时也保存修改、保存时重新生成失败的记为 `failed`。
  - 建 PR：本地 bare 仓库作 `origin`，`gh` 用假脚本（记录参数、输出 PR 链接）。覆盖 `edits` 和 `working_tree` 两种来源；确认用户工作区、当前分支、`git status` 都没变；工作区里有指向仓库外文件的符号链接时，推送的是链接本身而不是外部文件内容；可执行位、删除、重命名正确；执行或忽略后 `refs/codeinsight/proposals/<id>` 被删除；仓库里放一个会写标记文件的 pre-commit / pre-push / post-checkout 钩子，确认没有执行；推送成功但 gh 失败后重试能继续；分支已存在且内容不同时失败；未登录时失败。
  - diff 接口三种情况。
- web 单测：卡片各状态；会话列表收起状态读写；自动滚动（在底部时跟随、翻上去时不跟随）。
- e2e（Playwright + 假模型，`web/e2e/chat.spec.ts`、`chat-proposals.spec.ts`）：
  - 布局：消息很多时输入框在视口底部、会话列表位置不变；收起后刷新仍收起。
  - 假模型调用 `propose_file_changes` → 卡片 → 看 diff → 点“写入” → 文件写进临时仓库。
- 真实调用（本机 Claude Code，约 5 次）：改一个文件、建一个 PR（推到本地 bare 仓库，gh 用假脚本），确认它用新工具并能生成待确认修改。

## 8. 开发计划

- [x] 阶段1：问答页布局
  - 涉及模块：packages/web（app/App.tsx、chat/ChatPage.tsx、chat/SessionList.tsx、chat/Composer.tsx、styles.css、e2e/chat.spec.ts）
  - 依赖：无
  - 内容：`--header-h` 变量（含 `.source-panel`）、聊天布局、自动滚到底和“回到底部”、会话列表收起并记住状态
  - 完成标准：`pnpm --filter @codeinsight/web test`、`pnpm --filter @codeinsight/web build`、`pnpm lint` 通过；`pnpm --filter @codeinsight/web exec playwright test e2e/chat.spec.ts e2e/serve.spec.ts` 通过，新增用例检查消息很多时输入框在视口底部、会话列表不随滚动移动、收起状态刷新后保留。`e2e/serve.spec.ts` 工作区里有别人未提交的改动，本阶段只运行、不修改它

  - 验证：`pnpm --filter @codeinsight/web test` 141 通过；web build、`pnpm lint` 通过；`playwright test e2e/chat.spec.ts e2e/serve.spec.ts` 15 通过（新增布局、收起 2 条）；改动 `app/App.tsx`、`app/useHeaderHeight.ts`、`chat/ChatPage.tsx`、`chat/SessionList.tsx`、`chat/useFollowBottom.ts`、`stored-flag.ts`（`graph/show-models.tsx` 改用它，行为不变）、`styles.css`
- [x] 阶段2：写入范围、两个写工具和 `--add-dir`
  - 涉及模块：packages/core（ask/write-scope.ts、ask/apply-edits.ts、ask/redact.ts、ask/tools.ts、ask/prompt.ts、ask/events.ts、ask/agent.ts、ask/cli-agent.ts、ask/write-roots.ts）、packages/server（mcp/ask-tools.ts、http/routes/status.ts、http/server.ts）、packages/cli（commands/mcp.ts、commands/serve.ts）
  - 依赖：无
  - 验证方式：独立
  - 内容：路径检查和可写目录校验；两个工具定义、参数检查、edits 预演；只在带 sessionId 时提供；提示补充；参数去掉内容；`write_not_allowed` 错误码；MCP 的 `--write-tools`、`--writable-dir`；Claude Code 白名单；`serve --add-dir` 参数和检查；`/api/status` 返回写入范围
  - 完成标准：`pnpm --filter @codeinsight/core exec vitest run test/write-scope.test.ts test/write-roots.test.ts test/ask-write-tools.test.ts`、`pnpm --filter @codeinsight/server exec vitest run test/ask-tools-mcp.test.ts test/write-scope-status.test.ts` 通过；`pnpm -r build`、`pnpm lint` 通过

  - 验证：core 阶段测试 56 通过、core 全量 492 通过/10 跳过；server 阶段测试 12 通过、全量 147/7 跳过；cli 40/1 跳过；`pnpm -r build`、`pnpm lint` 通过。独立验证提 8 个问题已全部修复（`--add-dir` 拒绝包含主目录的目录、参数去内容改白名单、悬空链接、CLI 跳过的调用算失败、分支名 `@`/`refs/`、不可见字符、换行匹配、抽出 `realDirOrUndefined`）；web `tool-labels.ts` 补 `write_not_allowed` 说明；改动 `core/ask/{write-scope,write-roots,apply-edits,build-proposal,redact,tools,prompt,agent,cli-agent}.ts`、`server/mcp/ask-tools.ts`、`server/http/{server,context}.ts`、`routes/{status,chat}.ts`、`cli/commands/{mcp,serve}.ts`
- [x] 阶段3：待确认修改的保存和写文件
  - 涉及模块：packages/core（store/schema.ts、store/chats.ts、ask/agent.ts、ask/cli-agent.ts、git/write.ts、util/atomic-file.ts）、packages/server（jobs/ask-runs.ts、http/routes/chat.ts、proposals/）
  - 依赖：阶段2
  - 验证方式：独立
  - 内容：`chat_proposals` 表；core 记下写调用的原始参数；回答（done / limited）保存时重新生成修改并和回答同事务保存，发 `proposal` 事件；会话详情带卡片；diff、apply（files）、dismiss 接口；`applying` 状态和启动时恢复
  - 完成标准：`pnpm --filter @codeinsight/server exec vitest run test/chat-proposals.test.ts` 通过，覆盖 7 节 server 单测里除建 PR 以外的情况；`pnpm --filter @codeinsight/core test`、`pnpm -r build` 通过

  - 验证：`vitest run test/chat-proposals.test.ts` 18 通过；core 492/10 跳过、server 165/7 跳过、cli 40/1 跳过；`pnpm -r build`、`pnpm lint` 通过。独立验证提 6 个问题和 3 处测试缺口已修复（部分写入后重试跳过已写入文件、建目录前逐级检查不往仓库外写、保存阶段可取消且同一 base 只 fetch 一次、fetch 失败原因去掉绝对路径、diff 单独错误码和 1MB 上限、applying 超过 10 分钟视为中断、apply/dismiss 必须带仓库头）。自行决定：`working_tree` 来源暂存为 failed(not_supported)，阶段5 补；重新生成失败的记录标 unbuilt 不可执行；改动 `core/store/proposals.ts`、`core/ask/save-proposals.ts`、`core/ask/agent.ts`、`core/util/atomic-file.ts`、`core/git/{index,write}.ts`、`server/proposals/{apply-files,diff,service}.ts`、`server/http/{context,server}.ts`、`routes/chat.ts`、`server/repo-context.ts`
- [x] 阶段4：写文件确认卡片和写入范围说明（网页）
  - 涉及模块：packages/web（chat/ProposalCard.tsx、chat/DiffView.tsx、chat/answer.ts、chat/tool-labels.ts、chat/ToolSteps.tsx、chat/Composer.tsx、api/types.ts、e2e/chat-proposals.spec.ts）
  - 依赖：阶段1、阶段3
  - 内容：卡片（写文件）各状态、diff 展示、写入、忽略、“仍然写入”、失败重试；输入框上方的写入范围说明
  - 完成标准：`pnpm --filter @codeinsight/web test` 通过且覆盖卡片各状态；`pnpm --filter @codeinsight/web exec playwright test e2e/chat-proposals.spec.ts` 通过（假模型 → 卡片 → 写入临时仓库）；`pnpm --filter @codeinsight/web build`、`pnpm lint` 通过

  - 验证：与阶段5 合并后 `pnpm --filter @codeinsight/web test` 158 通过（新增 `test/proposals.test.tsx` 17 条覆盖卡片各状态）；`playwright test e2e/chat-proposals.spec.ts e2e/chat.spec.ts` 9 通过；`pnpm -r build`、`pnpm lint` 通过；改动 `api/{types,client}.ts`、`chat/{ProposalCard,DiffView,WriteScopeNote}.tsx`、`chat/{useProposal,proposal-text,answer,tool-labels}.ts`、`chat/{ToolSteps,MessageList,Composer,ChatPage}.tsx`、`styles.css`、`e2e/chat-proposals.spec.ts`
- [x] 阶段5：建 PR
  - 涉及模块：packages/core（git/write.ts）、packages/server（proposals/pull-request.ts、http/routes/chat.ts）
  - 依赖：阶段3
  - 验证方式：独立
  - 内容：4.5 的生成（fetch、working_tree 临时索引生成 tree 和引用）和执行流程，两种来源；diff 接口的 PR 情况；断点重试；执行或忽略后删除引用
  - 完成标准：`pnpm --filter @codeinsight/server exec vitest run test/pull-request.test.ts` 通过，覆盖 7 节建 PR 的全部情况（含钩子未执行、工作区不变）

  - 验证：`vitest run test/pull-request.test.ts` 16 通过（本地 bare 仓库 + 假 gh，含钩子未执行、工作区和用户索引不变、符号链接、可执行位、删除、断点重试、分支冲突、未登录、引用清理）；core 495/10 跳过、server 181/7 跳过、cli 40/1；`pnpm -r build`、`pnpm lint` 通过。独立验证提 8 个问题已修复（已有 PR 只认 OPEN 且指向本次提交、推送仓库以 pushurl 为准并按需 `--head=<owner>:<branch>`、从用户索引复制起步保留 skip-worktree、类型变化 diff、关闭 fsmonitor 并拒绝 LFS 文件、拒绝嵌套仓库、删除会话时删引用且引用名带数据目录区分、plink 用 `-batch`）。自行决定：代为执行的 git 命令一律不跑钩子（`core.hooksPath` 指向空设备，含 fetch）；推送直接用展开后的推送地址；改动 `core/git/write.ts`、`core/ask/save-proposals.ts`、`server/proposals/{pull-request,diff,service}.ts`、`routes/chat.ts`、`http/server.ts`
- [x] 阶段6：PR 确认卡片（网页）
  - 涉及模块：packages/web（chat/ProposalCard.tsx、e2e/chat-proposals.spec.ts）
  - 依赖：阶段4、阶段5
  - 内容：PR 卡片：目标分支、新分支、未推送提交提示、PR 链接和复制链接、失败重试
  - 完成标准：`pnpm --filter @codeinsight/web test` 覆盖 PR 卡片各状态并通过；`pnpm --filter @codeinsight/web build`、`pnpm lint` 通过

  - 验证：`pnpm --filter @codeinsight/web test` 165 通过（`test/proposals.test.tsx` 24 条，含 PR 卡片各状态、复制链接、pushed 说明、全部错误码中文）；`playwright test e2e/chat-proposals.spec.ts e2e/chat.spec.ts` 10 通过（新增 PR 卡片显示、看 diff、忽略）；`pnpm -r build`、`pnpm lint` 通过；改动 `chat/{ProposalCard,ProposalResult,DiffView}.tsx`、`chat/proposal-text.ts`、`api/types.ts`、`styles.css`
- [x] 阶段7：真实调用核实和收尾
  - 涉及模块：packages/core、packages/server 的集成测试（`local-cli.integration.test.ts`）
  - 依赖：阶段6
  - 内容：本机 Claude Code 真实调用约 5 次，改文件和建 PR 各至少一次（推到本地 bare 仓库，gh 用假脚本）；全量测试
  - 完成标准：真实调用中助手调用新工具并生成待确认修改，执行结果正确；`pnpm -r build`、`pnpm lint`、`pnpm -r test`、`pnpm --filter @codeinsight/web exec playwright test` 全部通过
  - 验证：`CODEINSIGHT_REAL_CLI=claude-code pnpm --filter @codeinsight/server exec vitest run test/local-cli.integration.test.ts` 7 通过 / 3 跳过（opencode）；真实调用本机 Claude Code 6 次，均一次通过：init 只有 9 个 codeinsight 工具且启动参数含 `--tools ''`，改文件 + 新建文件执行后内容正确，建 PR（edits、fromWorkingTree 两种来源，推到本地 bare 仓库、假 gh）成功且用户工作区不变；全量 `pnpm -r build`、`pnpm lint` 通过，core 495/10 跳过、server 181/10 跳过、web 165、cli 40/1 跳过，web e2e 29 通过 / 6 跳过（clauve）；无遗留进程

- [x] 阶段8：代码审查修复（第 1 轮）
  - 涉及模块：packages/core、packages/server、packages/web
  - 内容：同一次问答里对同一文件、同一分支的多次写工具调用按顺序叠加（每个文件只保留在最后一条记录里，内容含全部修改；同一分支的 edits 来源合并成一个 PR，working_tree 来源或 base 不同时拒绝）；PR 卡片显示正文（纯文本）；`ProposalView` 增加 `body`、`unbuilt`；会被工具链自动执行的文件（`.github/workflows`、`.claude`、`package.json`、`Makefile` 等）标为需要特别注意；默认目标分支统一取法（本地 origin/HEAD → ls-remote → gh）；fetch 用明确 refspec；`..` 开头目录名；失败原因去掉绝对路径；执行中超过 10 分钟可重新执行；自动滚到底只在内容变化时跟随、往上滚即停止；冲突后 diff 重新读取；unbuilt 卡片不可执行；合并重复实现（写工具名、git/gh 子进程调用、失败原因转换、“不存在”错误码、文件大小检查、错误说明文字）
  - 完成标准：core、server、cli、web 全量测试与 e2e 通过
  - 验证：`pnpm -r build`、`pnpm lint` 通过；core 504/10 跳过、server 184/10 跳过、cli 40/1 跳过、web 176；web e2e 29 通过 / 6 跳过（clauve）

- [x] 阶段9：代码审查修复（第 2 轮）
  - 涉及模块：packages/core、packages/server、packages/cli、packages/web
  - 内容：叠加改为按卡片整条合并（后一次调用涉及前面卡片的任一文件或同一分支时，整张并入，文件取并集、内容按调用顺序叠加、说明用“；”拼接），一张卡片就是一组完整修改；同一会话里还在等待确认的旧卡片也参与合并，旧卡片改为“已并入后面的修改”，保存时旧卡片已被执行或忽略则新卡片记为失败（`merge_base_changed`）；本机 CLI 路径用 `mcp --session` 让 MCP 子进程读同一会话的待确认修改，写工具结果带执行序号 `(change #N)`，保存时按它排序；`ProposalView` 增加 `retryable`，执行中超过 10 分钟可在网页重试或忽略；diff 读取中途重新执行时会再读一次；工具步骤标题按实际卡片数
  - 完成标准：core、server、cli、web 全量测试与 e2e 通过
  - 验证：`pnpm -r build`、`pnpm lint` 通过；core 509/10 跳过、server 187/10 跳过、cli 40/1 跳过、web 179；web e2e 29 通过 / 6 跳过（clauve）

## 9. 待确认问题

无。

2026-11-13 东凯确认的结论（已写进正文）：
- 采用受限工具的做法：本机 Claude Code 只提供模型，写文件和建 PR 用新增的两个受限工具，页面确认后由 serve 执行；Claude Code 自带的写文件、执行命令工具保持关闭。
- 写入范围和 Claude Code 一样在启动时确定：当前打开的仓库，加上 `serve --add-dir` 指定的目录（只能新建文件）；不提供网页设置。
- 写文件和建 PR 每次都要在页面上确认。
- 建 PR 支持助手给出的修改和工作区未提交改动两种来源。
- 建 PR 跳过 git 钩子（推送加 `--no-verify`），提交签名按用户 git 配置。
- 发给模型的只有仓库内相对路径和 `--add-dir` 目录的最后一级目录名。
- 开发期间真实调用本机 Claude Code 约 5 次；不在 GitHub 上建真 PR。
