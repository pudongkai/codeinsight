package dev.codeinsight.idea.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import dev.codeinsight.idea.CodeInsightService

/** 设置 → 工具 → CodeInsight：Node 路径、codeinsight 路径、数据目录。修改后重启本项目的 serve */
class CodeInsightConfigurable(private val project: Project) : BoundConfigurable("CodeInsight") {
    private val app = CodeInsightSettings.getInstance().state
    private val proj = CodeInsightProjectSettings.getInstance(project).state

    override fun createPanel(): DialogPanel = panel {
        row("Node 路径：") {
            textFieldWithBrowseButton(FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor(), project)
                .bindText(app::nodePath).align(AlignX.FILL)
                .comment("需要 Node ≥ 22.13。留空时依次查找登录 shell 的 PATH 和 Homebrew、nvm、Volta、fnm、asdf、mise 的安装目录。")
        }
        row("codeinsight 路径：") {
            textFieldWithBrowseButton(FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor(), project)
                .bindText(app::codeinsightPath).align(AlignX.FILL)
                .comment("留空时依次查找 Node 所在目录和 PATH。安装：<code>npm install -g codeinsight</code>")
        }
        row("数据目录：") {
            textFieldWithBrowseButton(FileChooserDescriptorFactory.createSingleFolderDescriptor(), project)
                .bindText(proj::dataDir).align(AlignX.FILL)
                .comment("只对本项目生效。留空时为仓库内的 <code>.codeinsight/</code>。")
        }
    }

    override fun apply() {
        val modified = isModified
        super.apply()
        if (modified) CodeInsightService.getInstance(project).restartIfStarted()
    }
}
