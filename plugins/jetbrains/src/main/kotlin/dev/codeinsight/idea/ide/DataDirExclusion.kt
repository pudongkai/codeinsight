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
import java.nio.file.InvalidPathException
import java.nio.file.Path

private val LOG = logger<DataDirExclusion>()

/**
 * 数据目录里有快照源码副本，被 IDE 索引会在查找用法、搜索里出现重复结果。
 * serve 启动后检查它是否已是排除目录，不是就弹通知；标记排除会改项目的 `.idea` 配置，所以等用户点击，不自动改。
 */
object DataDirExclusion {
    const val NOTIFICATION_GROUP = "CodeInsight"
    private val CHECKED = Key.create<Boolean>("codeinsight.dataDirExclusionChecked")

    /** 与 serve 一致：留空为 `<repo>/.codeinsight`，相对路径按仓库根目录解析；不在仓库内（或就是仓库根）时返回 null */
    fun dataDirInRepo(repo: Path, setting: String?): Path? {
        val raw = setting?.trim().orEmpty().ifEmpty { ".codeinsight" }
        val dir = try {
            repo.resolve(raw).normalize()
        } catch (_: InvalidPathException) {
            return null
        }
        val root = repo.normalize()
        return dir.takeIf { it != root && it.startsWith(root) }
    }

    /** 每个项目每次打开只检查一次（后台线程调用） */
    fun checkOnce(project: Project, repo: Path, setting: String?) {
        if (project.isDisposed || project.getUserData(CHECKED) == true) return
        project.putUserData(CHECKED, true)
        val dir = dataDirInRepo(repo, setting) ?: return
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
