# CodeInsight JetBrains 插件手工检查清单

需要在真实 IDE 里操作的检查，对应技术方案阶段 7 的完成标准。PyCharm 和 IntelliJ IDEA 各做一遍（用不需要付费许可的版本）。
每条写"操作"和"预期"，不符合预期时记下 IDE 日志（Help → Show Log in Finder，搜 `dev.codeinsight`）。

## 0. 准备

1. 构建插件：
   ```
   cd plugins/jetbrains
   JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew buildPlugin
   ```
   产物：`plugins/jetbrains/build/distributions/codeinsight-jetbrains-0.1.0.zip`，用于 2026.2 及以后的 IDE。2025.1–2026.1 的 IDE 用 `./gradlew -PideTarget=251 buildPlugin` 打出的 `codeinsight-jetbrains-0.1.0-251.zip`（2026.2 起 JCEF 是单独的插件，两个版本段的依赖声明不同）。
2. 让 `codeinsight` 命令可用（还没发布到 npm 时用本仓库）：
   ```
   pnpm -r build
   cd packages/cli && npm link     # 或在插件设置里把 codeinsight 路径填成 <仓库>/packages/cli/dist/main.js
   ```
   终端里 `which node` 应指向 nvm 或 Homebrew 的 Node（≥ 22.13），`which codeinsight` 有结果。
3. 准备一个小 Python 项目（git 仓库，至少两个文件，一个函数调用另一个），已提交一次。例如：
   ```
   mkdir /tmp/ci-demo && cd /tmp/ci-demo && git init
   mkdir pkg && printf 'def helper(x):\n    return x + 1\n' > pkg/util.py
   printf 'from pkg.util import helper\n\ndef run():\n    return helper(1)\n' > pkg/app.py
   git add . && git commit -m init
   ```
4. 打开 IDE 前确认没有残留进程：`pgrep -fl "codeinsight.*serve"` 无输出。

## 1. 安装插件

1. 操作：Settings → Plugins → ⚙ → Install Plugin from Disk…，选第 0 步的 zip，按提示重启 IDE。
   预期：安装成功，Plugins 列表里有 CodeInsight；右侧工具窗口栏出现 CodeInsight 图标；Tools 菜单里有"审查未提交改动"。
2. 操作：Settings → Tools → CodeInsight。
   预期：有"Node 路径""codeinsight 路径""数据目录"三项，默认为空。

## 2. 从 Dock 启动时找到 Node（macOS）

1. 操作：完全退出 IDE（Cmd+Q），**从 Dock 或 Finder** 启动（不要从终端启动），打开 `/tmp/ci-demo`，设置里的 Node 路径保持为空。点开 CodeInsight 工具窗口。
   预期：几秒内显示 Web UI，不出现"没有找到 Node"。IDE 日志里有 `using Node <版本> at <路径> (from PATH 或 COMMON_DIR)`，路径是 nvm 或 Homebrew 的 Node。
2. 如果本机同时有 nvm 和 Homebrew 两种 Node：
   预期：用的是登录 shell 里 `which node` 那一个（日志 `from PATH`）。

## 3. 找不到 Node 或 codeinsight 时的安装指引

1. 操作：设置里把 Node 路径填成 `/nonexistent/node`，确定。
   预期：工具窗口重启 serve，仍能正常显示（设置路径无效时继续按 PATH 和常见目录查找）。
2. 操作：临时让 Node 不可见——设置里 Node 路径留空，在终端 `mv ~/.nvm ~/.nvm.bak`（或其他让 Node 找不到的方式，做完记得恢复），重启 IDE 后打开工具窗口。
   预期：工具窗口显示"没有找到 Node ≥ 22.13"、安装步骤、"查找过但不能用的"列表，以及"重试""打开设置"两个按钮。恢复 Node 后点"重试"，页面正常显示。
3. 操作：设置里 codeinsight 路径留空，临时 `npm unlink -g codeinsight`（或改名），重启 IDE 打开工具窗口。
   预期：显示"没有找到 codeinsight 命令"、`npm install -g codeinsight` 的指引和已找到的 Node 路径。"打开设置"按钮能打开 CodeInsight 设置页。恢复后点"重试"能正常显示。
4. 操作：保持 codeinsight 找不到的状态，关闭项目再打开，**不先打开工具窗口**，直接 Tools → 审查未提交改动；看到安装指引后恢复 codeinsight，点"重试"。
   预期：页面正常显示，但不自动发起审查（停留在默认页面，没有新的"审查 #N 进行中"）。

## 4. `.codeinsight` 排除目录通知

1. 操作：在一个从没打开过 CodeInsight 的项目里（如 `/tmp/ci-demo`，先删掉 `.codeinsight/`），打开工具窗口。
   预期：serve 启动后右下角弹出通知"CodeInsight 数据目录未被排除"，带"将 .codeinsight 标记为排除目录"按钮。
2. 操作：先做一次审查（第 5 节），让 `.codeinsight/snapshots/` 里有快照副本，然后对 `helper` 用 Find Usages，再全局搜索 `def helper`。
   预期（标记前）：结果里出现 `.codeinsight/snapshots/...` 下的重复项。
3. 操作：点通知里的按钮。
   预期：Project 视图里 `.codeinsight` 变为排除目录（橙色图标）；Project Structure → Modules 的 Excluded Folders 里有它；再做第 2 步的查找，不再出现快照里的结果。
4. 操作：关闭项目再打开、打开工具窗口。
   预期：不再弹通知。
5. 操作：另一个项目里忽略通知（不点按钮），关闭再打开项目、打开工具窗口。
   预期：再次弹出通知（每次打开项目检查一次）。
6. 数据目录被环境变量或配置文件改到仓库内其他位置时，提示的是 serve 实际用的目录：
   - 操作：插件设置里数据目录留空，在仓库根写 `codeinsight.config.json`，内容为 `{"dataDir": "build/ci-data"}`，删掉 `.codeinsight/`，关闭并重新打开项目、打开工具窗口。
     预期：通知里的目录名是 `ci-data`，按钮把 `build/ci-data` 标记为排除目录；仓库里没有新建 `.codeinsight/`。
   - 操作：删掉配置文件，在登录 shell 的配置里 `export CODEINSIGHT_DATA_DIR=/tmp/ci-demo-env-data`，完全退出 IDE 后从 Dock 启动，打开项目和工具窗口。
     预期：不弹排除通知（数据目录在仓库外），`/tmp/ci-demo-env-data` 下出现 `index.db`。做完删掉这行 export。
7. 在仓库的子目录打开项目（如只打开 `/tmp/ci-demo/pkg`），打开工具窗口。
   预期：页面显示的是整个仓库的数据；点击 `pkg/app.py` 里的函数能跳到编辑器；排除通知针对仓库根下的 `.codeinsight`。

## 5. 审查未提交改动

1. 操作：在编辑器里修改 `pkg/util.py` 的 `helper` 函数体，新增一个函数，**不要保存**（或确认 IDE 尚未自动保存），然后 Tools → 审查未提交改动。
   预期：未保存的修改先被保存；工具窗口打开并切到"审查"标签，显示"审查 #N 进行中"，完成后显示改动清单，其中 `helper` 为 modified，新函数为 added。
2. 操作：关掉工具窗口（不关项目），再从工具窗口标题栏的"审查未提交改动"按钮发起一次。
   预期：同上，页面切到新的这次审查。
3. 操作：关闭项目后重新打开，**不先打开工具窗口**，直接 Tools → 审查未提交改动。
   预期：工具窗口打开，serve 启动、页面加载完成后自动发起审查并显示进度和报告（启动前发起的请求不会丢）。

## 6. 点击函数跳转

1. 操作：在审查报告里点击 `helper`（或影响面、调用方里的函数链接）。
   预期：编辑器打开 `pkg/util.py` 并把光标放在 `def helper` 那一行；页面里不出现源码面板。
2. 操作：切到"浏览"标签，搜索 `helper`，在邻居图里双击 `run` 节点或点详情里的位置。
   预期：编辑器打开 `pkg/app.py` 并跳到 `def run` 那一行。
3. 操作：删除一个已提交的函数后再审查，点击这个 removed 函数。
   预期：不跳到编辑器，在页面的源码面板里显示 base 版本的源码。
4. 仓库内指向仓库外的符号链接不能被打开：
   - 操作：`mkdir -p /tmp/ci-outside && printf 'def secret():\n    return 0\n' > /tmp/ci-outside/s.py && ln -s /tmp/ci-outside /tmp/ci-demo/ext`，在内嵌页面里按 F12（或 Find Action → Open DevTools）打开开发者工具，Console 执行 `window.codeinsightHost.openFile('ext/s.py', 1)`。
     预期：编辑器不打开 `/tmp/ci-outside/s.py`，IDE 日志里有 `openFile rejected a path that is missing or outside the repository: ext/s.py`。
   - 操作：Console 执行 `window.codeinsightHost.openFile('pkg/util.py', 1)`。
     预期：正常打开。做完 `rm /tmp/ci-demo/ext`。
5. 页面不能离开 serve 的地址：
   - 操作：开发者工具 Console 执行 `location.href = 'https://example.com'`。
     预期：页面不跳转，IDE 日志里有 `blocked navigation away from the web UI (opened externally: false)`。
   - 操作：Console 执行 `document.body.insertAdjacentHTML('beforeend', '<a id=x href="https://example.com">x</a>')`，再用鼠标点页面底部出现的 x 链接。
     预期：内嵌页面不跳转，系统浏览器打开 example.com。

## 7. JCEF 不可用时

1. 操作：Help → Find Action → Registry…，把 `ide.browser.jcef.enabled` 设为 false，重启 IDE，打开工具窗口。
   预期：工具窗口显示"当前 IDE 不支持内嵌浏览器（JCEF）"和"在浏览器中打开"按钮；点按钮后系统浏览器打开页面并能正常使用；页面里点击函数显示源码面板。
2. 操作：此时执行"审查未提交改动"。
   预期：系统浏览器打开页面（需要在页面里手动点"开始审查"）。
3. 恢复 `ide.browser.jcef.enabled` 为 true。

## 8. 关闭项目后 serve 退出

1. 操作：打开工具窗口让页面显示出来，终端执行 `pgrep -fl "codeinsight.*serve"`。
   预期：有一个 serve 进程，命令行里有 `--repo /tmp/ci-demo` 和 `--exit-on-stdin-close`（没有 token）。
2. 操作：File → Close Project。等几秒后再执行 `pgrep -fl "codeinsight.*serve"` 和 `pgrep -fl scip-python`。
   预期：都没有输出。IDE 日志里有 `stopping serve: pid=... (SIGTERM)` 和 `serve exited: pid=... exitCode=...`。
3. 操作：发起一次审查，在审查进行中（scip-python 运行时）关闭项目。
   预期：项目窗口立刻关闭，界面不卡顿（等待 serve 退出在后台进行）；之后 serve 和 scip-python 都退出（最多约 6 秒，超时会被强杀，日志里有 `killing`）。
4. 操作：打开两个项目都打开工具窗口，然后 Cmd+Q 退出 IDE。
   预期：退出后没有残留的 serve 进程。
5. 操作：同时打开两个项目的工具窗口。
   预期：两个页面互不影响（各自显示自己仓库的数据），关闭一个项目不影响另一个。
6. IDE 崩溃或被强杀时 serve 也退出：
   - 操作：打开工具窗口，发起一次审查，趁 scip-python 运行时在终端执行 `kill -9 <IDE 主进程 pid>`（`pgrep -f "PyCharm.app/Contents/MacOS"` 或对应 IDE 的路径可查 pid）。
     预期：几秒内 `pgrep -fl "codeinsight.*serve"` 和 `pgrep -fl scip-python` 都没有输出（serve 读到 stdin 关闭后按 SIGTERM 同样的流程清理退出），数据目录 `scip/` 下没有残留的 `.tmp` 文件。

## 9. 设置修改

1. 操作：Settings → Tools → CodeInsight，把数据目录改为 `/tmp/ci-demo-data`，确定。
   预期：工具窗口重启 serve 并重新加载；`/tmp/ci-demo-data` 下出现 `index.db`；不再提示仓库内 `.codeinsight` 的排除通知。

## 10. 日志里不出现 token

1. 操作：完成以上检查后，在 IDE 日志里搜索 `token=`。
   预期：只有 serve 自己的日志字段名（如有），没有 `?token=` 加一长串随机字符的完整地址；`serve ready` 那一行只有不带 token 的 `http://127.0.0.1:<端口>/`。
