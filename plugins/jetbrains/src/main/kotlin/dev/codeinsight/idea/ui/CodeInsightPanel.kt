package dev.codeinsight.idea.ui

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.jcef.JBCefApp
import com.intellij.util.ui.JBUI
import dev.codeinsight.idea.CodeInsightService
import dev.codeinsight.idea.ServeState
import dev.codeinsight.idea.serve.ServeInfo
import dev.codeinsight.idea.settings.CodeInsightConfigurable
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JPanel
import javax.swing.SwingConstants

/** 工具窗口内容：按 serve 的状态显示启动中、内嵌页面、外部浏览器按钮或安装指引 */
class CodeInsightPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {
    private val service = CodeInsightService.getInstance(project)
    private var browser: BrowserView? = null
    private var pendingReview = false

    init {
        service.addListener(this, ::render)
        render(service.state)
    }

    /** "审查未提交改动"：页面还没准备好时先记下，页面出现后再发起 */
    fun requestReviewWorking() {
        val state = service.state
        when {
            browser != null -> browser!!.requestReviewWorking()
            state is ServeState.Running && !JBCefApp.isSupported() -> BrowserUtil.browse(state.info.loginUrl)
            else -> {
                pendingReview = true
                service.start()
            }
        }
    }

    private fun render(state: ServeState) {
        disposeBrowser()
        removeAll()
        when (state) {
            ServeState.Idle, ServeState.Starting -> add(centered("正在启动 codeinsight serve…"), BorderLayout.CENTER)
            ServeState.NoProject -> add(centered("项目没有本地目录，无法启动 CodeInsight。"), BorderLayout.CENTER)
            is ServeState.Running -> showRunning(state.info)
            is ServeState.Missing -> showHtml(InstallGuide.missing(state.what), retryButtons())
            is ServeState.Failed -> showHtml(InstallGuide.failed(state.message, state.stderrTail), retryButtons())
        }
        revalidate()
        repaint()
    }

    private fun showRunning(info: ServeInfo) {
        val repo = service.repoRoot ?: return
        if (!JBCefApp.isSupported()) {
            val open = JButton("在浏览器中打开").apply { addActionListener { BrowserUtil.browse(info.loginUrl) } }
            showHtml(InstallGuide.noJcef(info.baseUrl), listOf(open))
            return
        }
        val view = BrowserView(project, repo, info)
        browser = view
        add(view.component, BorderLayout.CENTER)
        if (pendingReview) {
            pendingReview = false
            view.requestReviewWorking()
        }
    }

    private fun retryButtons(): List<JComponent> = listOf(
        JButton("重试").apply { addActionListener { service.start() } },
        JButton("打开设置").apply {
            addActionListener { ShowSettingsUtil.getInstance().showSettingsDialog(project, CodeInsightConfigurable::class.java) }
        },
    )

    private fun showHtml(html: String, buttons: List<JComponent>) {
        val pane = JEditorPane("text/html", html).apply {
            isEditable = false
            border = JBUI.Borders.empty(8)
        }
        add(JBScrollPane(pane), BorderLayout.CENTER)
        add(JPanel(FlowLayout(FlowLayout.LEFT)).apply { buttons.forEach { add(it) } }, BorderLayout.SOUTH)
    }

    private fun centered(text: String) = JBLabel(text, SwingConstants.CENTER)

    private fun disposeBrowser() {
        browser?.let { Disposer.dispose(it) }
        browser = null
    }

    override fun dispose() = disposeBrowser()
}
