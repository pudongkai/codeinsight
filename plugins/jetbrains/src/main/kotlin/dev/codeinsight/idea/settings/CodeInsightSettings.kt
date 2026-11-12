package dev.codeinsight.idea.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/** IDE 级设置：Node 和 codeinsight 的路径，留空时自动查找 */
@Service(Service.Level.APP)
@State(name = "dev.codeinsight.Settings", storages = [Storage("codeinsight.xml")])
class CodeInsightSettings : PersistentStateComponent<CodeInsightSettings.Data> {
    data class Data(var nodePath: String = "", var codeinsightPath: String = "")

    private var data = Data()

    override fun getState(): Data = data

    override fun loadState(state: Data) {
        data = state
    }

    companion object {
        fun getInstance(): CodeInsightSettings = service()
    }
}

/** 项目级设置：数据目录（留空为仓库内的 `.codeinsight/`）。存在 workspace.xml，不随项目配置提交 */
@Service(Service.Level.PROJECT)
@State(name = "dev.codeinsight.ProjectSettings", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class CodeInsightProjectSettings : PersistentStateComponent<CodeInsightProjectSettings.Data> {
    data class Data(var dataDir: String = "")

    private var data = Data()

    override fun getState(): Data = data

    override fun loadState(state: Data) {
        data = state
    }

    companion object {
        fun getInstance(project: Project): CodeInsightProjectSettings = project.service()
    }
}
