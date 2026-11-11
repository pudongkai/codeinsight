package dev.codeinsight.idea.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.nio.file.InvalidPathException
import java.nio.file.Path

private val LOG = logger<SourceNavigator>()

/** JS 桥 `openFile(path, line)`：path 是相对仓库根目录的路径，line 从 1 开始 */
object SourceNavigator {
    /** 只接受仓库内的相对路径，防止页面让 IDE 打开仓库外的文件 */
    fun resolveInRepo(repo: Path, relative: String): Path? {
        val rel = try {
            Path.of(relative)
        } catch (_: InvalidPathException) {
            return null
        }
        if (relative.isBlank() || rel.isAbsolute) return null
        val root = repo.normalize()
        return root.resolve(rel).normalize().takeIf { it.startsWith(root) && it != root }
    }

    /** 在后台线程上查找文件，找到后在 EDT 上打开并跳到行 */
    fun open(project: Project, repo: Path, relative: String, line: Int) {
        val path = resolveInRepo(repo, relative)
        if (path == null) {
            LOG.warn("openFile rejected a path outside the repository: $relative")
            return
        }
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path)
        if (vf == null) {
            LOG.warn("openFile: file not found: $path")
            return
        }
        ApplicationManager.getApplication().invokeLater({
            OpenFileDescriptor(project, vf, (line - 1).coerceAtLeast(0), 0).navigate(true)
        }, project.disposed)
    }
}
