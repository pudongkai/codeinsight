package dev.codeinsight.idea.ide

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import dev.codeinsight.idea.ui.CodeInsightPanel

private val LOG = logger<ReviewWorkingAction>()

/** "审查未提交改动"：动作和 JS 桥 `reviewWorking()` 共用 */
object ReviewWorking {
    const val TOOL_WINDOW_ID = "CodeInsight"

    /** 先保存所有编辑器（审查读的是磁盘上的工作区），再打开工具窗口，由页面发起工作区审查并切到这次审查。在 EDT 上调用 */
    fun run(project: Project) {
        FileDocumentManager.getInstance().saveAllDocuments()
        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID) ?: return
        LOG.info("review working tree requested")
        toolWindow.activate {
            val panel = toolWindow.contentManager.contents.firstNotNullOfOrNull { it.component as? CodeInsightPanel }
            panel?.requestReviewWorking()
        }
    }
}

class ReviewWorkingAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        ReviewWorking.run(e.project ?: return)
    }
}
