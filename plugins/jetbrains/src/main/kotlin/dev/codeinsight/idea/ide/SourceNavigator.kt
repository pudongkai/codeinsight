package dev.codeinsight.idea.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.io.IOException
import java.nio.file.InvalidPathException
import java.nio.file.Path

private val LOG = logger<SourceNavigator>()

/** JS 桥 `openFile(path, line)`：path 是相对仓库根目录的路径，line 从 1 开始 */
object SourceNavigator {
    /**
     * 只接受仓库内的相对路径，防止页面让 IDE 打开仓库外的文件。仓库和目标都解析符号链接后再比较，
     * 仓库内指向外部的链接（如 `link -> ~/.ssh`）会被拒绝；目标不存在时也返回 null。
     * 检查通过后返回按仓库路径拼出的路径（不是真实路径），IDE 才会把它当作项目里的文件打开。
     */
    fun resolveInRepo(repo: Path, relative: String): Path? {
        val rel = try {
            Path.of(relative)
        } catch (_: InvalidPathException) {
            return null
        }
        if (relative.isBlank() || rel.isAbsolute) return null
        val root = repo.normalize()
        val target = root.resolve(rel).normalize()
        if (!target.startsWith(root) || target == root) return null
        val realRoot = realPath(root) ?: return null
        val realTarget = realPath(target) ?: return null
        return target.takeIf { realTarget.startsWith(realRoot) && realTarget != realRoot }
    }

    private fun realPath(path: Path): Path? = try {
        path.toRealPath()
    } catch (_: IOException) {
        null
    }

    /** 在后台线程上查找文件，找到后在 EDT 上打开并跳到行 */
    fun open(project: Project, repo: Path, relative: String, line: Int) {
        val path = resolveInRepo(repo, relative)
        if (path == null) {
            LOG.warn("openFile rejected a path that is missing or outside the repository: $relative")
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
