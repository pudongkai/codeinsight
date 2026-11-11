package dev.codeinsight.idea.ui

import com.intellij.openapi.util.text.StringUtil
import dev.codeinsight.idea.runtime.MissingRuntime
import dev.codeinsight.idea.runtime.NodeVersion
import dev.codeinsight.idea.runtime.Rejected

/** 工具窗口里显示的安装指引和错误说明（HTML） */
object InstallGuide {
    fun missing(what: MissingRuntime): String = when (what) {
        is MissingRuntime.Node -> page(
            "没有找到 Node ≥ ${NodeVersion.MINIMUM}",
            """
            <p>CodeInsight 通过本机的 Node 运行 <code>codeinsight serve</code>，插件不自带 Node。</p>
            <ol>
              <li>安装 Node ${NodeVersion.MINIMUM.major}（≥ ${NodeVersion.MINIMUM}）或更新的 LTS：
                <code>brew install node</code>，或 <code>nvm install 22</code>，或从 https://nodejs.org 下载。</li>
              <li>安装后点"重试"。插件会读取登录 shell 的 PATH，并查找 Homebrew、nvm、Volta、fnm、asdf、mise 的安装目录。</li>
              <li>仍然找不到时，在"设置 → 工具 → CodeInsight"里填写 Node 的完整路径（终端里 <code>which node</code> 的结果）。</li>
            </ol>
            """ + rejectedList(what.rejected),
        )
        is MissingRuntime.CodeInsight -> page(
            "没有找到 codeinsight 命令",
            """
            <p>已找到 Node：<code>${esc(what.node.toString())}</code></p>
            <ol>
              <li>用这个 Node 对应的 npm 安装：<code>npm install -g codeinsight</code></li>
              <li>安装后点"重试"。插件会在 Node 所在目录、PATH 和常见安装目录里查找。</li>
              <li>仍然找不到时，在"设置 → 工具 → CodeInsight"里填写 codeinsight 的完整路径（终端里 <code>which codeinsight</code> 的结果）。</li>
            </ol>
            """ + rejectedList(what.rejected),
        )
    }

    fun failed(message: String, stderrTail: List<String>): String {
        val tail = if (stderrTail.isEmpty()) "" else "<p>serve 的最后几行输出：</p><pre>${esc(stderrTail.joinToString("\n"))}</pre>"
        return page("codeinsight serve 没有正常运行", "<p>${esc(message)}</p>$tail<p>处理后点\"重试\"。</p>")
    }

    fun noJcef(baseUrl: String): String = page(
        "当前 IDE 不支持内嵌浏览器（JCEF）",
        "<p>CodeInsight 已在 <code>${esc(baseUrl)}</code> 运行，请点\"在浏览器中打开\"。" +
            "外部浏览器里没有 IDE 跳转，点击函数时在页面的源码面板里显示。</p>",
    )

    private fun rejectedList(rejected: List<Rejected>): String {
        if (rejected.isEmpty()) return ""
        val items = rejected.joinToString("") { "<li><code>${esc(it.path.toString())}</code>：${esc(it.reason)}</li>" }
        return "<p>查找过但不能用的：</p><ul>$items</ul>"
    }

    private fun page(title: String, body: String) = "<html><body><h3>${esc(title)}</h3>$body</body></html>"

    private fun esc(s: String) = StringUtil.escapeXmlEntities(s)
}
