package dev.codeinsight.idea.ui

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import dev.codeinsight.idea.CodeInsightService

/** 第一次打开工具窗口时创建内容并启动 serve */
class CodeInsightToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = CodeInsightPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, null, false)
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
        ActionManager.getInstance().getAction(REVIEW_ACTION_ID)?.let { toolWindow.setTitleActions(listOf(it)) }
        CodeInsightService.getInstance(project).start()
    }

    private companion object {
        const val REVIEW_ACTION_ID = "CodeInsight.ReviewWorking"
    }
}
