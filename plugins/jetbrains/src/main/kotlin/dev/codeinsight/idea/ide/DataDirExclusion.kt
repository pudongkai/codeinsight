package dev.codeinsight.idea.ide

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.module.Module
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ModuleRootModificationUtil
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.util.Computable
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import dev.codeinsight.idea.serve.ServeInfo
import java.nio.file.Path

private val LOG = logger<DataDirExclusion>()

/**
 * 数据目录里有快照源码副本，被 IDE 索引会在查找用法、搜索里出现重复结果。
 * serve 启动后检查它是否已是排除目录，不是就弹通知；标记排除会改项目的 `.idea` 配置，所以等用户点击，不自动改。
 */
object DataDirExclusion {
    const val NOTIFICATION_GROUP = "CodeInsight"
    private val CHECKED = Key.create<Boolean>("codeinsight.dataDirExclusionChecked")

    /** serve 报告的数据目录在仓库内（且不是仓库根本身）时才需要排除 */
    fun needsExclusion(repo: Path, dataDir: Path): Boolean {
        val root = repo.normalize()
        val dir = dataDir.normalize()
        return dir != root && dir.startsWith(root)
    }

    /** 每个项目每次打开只检查一次（后台线程调用）；目录用 serve 输出的实际值 */
    fun checkOnce(project: Project, info: ServeInfo) {
        if (project.isDisposed || project.getUserData(CHECKED) == true) return
        project.putUserData(CHECKED, true)
        if (!needsExclusion(info.repo, info.dataDir)) return
        val dir = info.dataDir
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(dir) ?: return
        val module = ApplicationManager.getApplication().runReadAction(Computable<Module?> {
            val index = ProjectFileIndex.getInstance(project)
            if (project.isDisposed || !index.isInContent(vf)) null else index.getModuleForFile(vf)
        }) ?: return
        LOG.info("data directory is not excluded, asking the user: $dir")
        notify(project, module, vf)
    }

    private fun notify(project: Project, module: Module, dir: VirtualFile) {
        NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification(
                "CodeInsight 数据目录未被排除",
                "${dir.name} 里有代码快照的副本，不排除时查找用法和搜索会出现重复结果。",
                NotificationType.INFORMATION,
            )
            .addAction(NotificationAction.createSimpleExpiring("将 ${dir.name} 标记为排除目录") { exclude(module, dir) })
            .notify(project)
    }

    private fun exclude(module: Module, dir: VirtualFile) {
        if (module.isDisposed || !dir.isValid) return
        ModuleRootModificationUtil.updateModel(module) { model ->
            val entry = model.contentEntries.firstOrNull { e -> e.file?.let { VfsUtilCore.isAncestor(it, dir, false) } == true }
            if (entry == null) {
                LOG.warn("no content entry contains ${dir.path}")
            } else {
                entry.addExcludeFolder(dir)
                LOG.info("excluded data directory ${dir.path} in module ${module.name}")
            }
        }
    }
}
