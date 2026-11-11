package dev.codeinsight.idea.runtime

import com.intellij.openapi.diagnostic.logger
import dev.codeinsight.idea.serve.ServeLaunchException
import java.io.IOException
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path

private val LOG = logger<ServeProgram>()

/** 启动 serve 的程序：用 Node 运行的 JS 入口，或直接执行的可执行文件 */
sealed interface ServeProgram {
    data class NodeScript(val script: Path) : ServeProgram
    data class Executable(val path: Path) : ServeProgram
}

/**
 * 决定怎样运行找到的 codeinsight：
 * - npm 生成的 JS 入口（或以 `#!...node` 开头的脚本）用 Node 运行；
 * - Windows 的 `.cmd` / `.bat`（npm、pnpm 生成的 shim）解析出它调用的 JS 入口，再用 Node 运行，不经过 cmd.exe；
 *   解析不出时抛出 [ServeLaunchException]，不退回用 cmd 执行；
 * - 其他情况直接执行。
 */
fun resolveServeProgram(codeinsight: Path, windows: Boolean): ServeProgram {
    if (isNodeScript(codeinsight)) return ServeProgram.NodeScript(codeinsight)
    val name = codeinsight.fileName?.toString().orEmpty().lowercase()
    if (windows && (name.endsWith(".cmd") || name.endsWith(".bat"))) {
        val entry = CmdShim.entryOf(codeinsight) ?: throw ServeLaunchException(
            "cannot find the JavaScript entry that $codeinsight runs; set the codeinsight path in " +
                "Settings > Tools > CodeInsight to the dist/main.js of the codeinsight package",
            emptyList(),
        )
        return ServeProgram.NodeScript(entry)
    }
    return ServeProgram.Executable(codeinsight)
}

/** npm / pnpm 在 Windows 上生成的 `.cmd` shim：形如 `"%~dp0\..\codeinsight\dist\main.js" %*` 或 `"%dp0%\node_modules\...\main.js"` */
object CmdShim {
    private val ENTRY = Regex("""(?i)"(?:%~dp0%?|%dp0%)[\\/]*([^"%]+?\.[cm]?js)"""")

    /** shim 里调用的 JS 入口（按 shim 所在目录解析）；文件不存在或解析不出时返回 null */
    fun entryOf(shim: Path): Path? {
        val text = try {
            Files.readString(shim)
        } catch (e: IOException) {
            LOG.warn("cannot read $shim", e)
            return null
        }
        val dir = shim.toAbsolutePath().parent ?: return null
        return ENTRY.findAll(text)
            .mapNotNull { resolveRelative(dir, it.groupValues[1]) }
            .firstOrNull { Files.isRegularFile(it) }
    }

    /** shim 里用反斜杠分隔，逐段解析，非 Windows 上的单测也能用 */
    private fun resolveRelative(dir: Path, relative: String): Path? = try {
        relative.split('\\', '/').filter { it.isNotEmpty() }.fold(dir) { acc, part -> acc.resolve(part) }.normalize()
    } catch (_: InvalidPathException) {
        null
    }
}

/** npm 生成的入口是 JS 文件（或指向它的符号链接），或以 `#!...node` 开头的脚本 */
private fun isNodeScript(path: Path): Boolean = try {
    val real = path.toRealPath()
    val name = real.fileName.toString()
    if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) {
        true
    } else {
        val head = Files.newInputStream(real).use { it.readNBytes(256) }.decodeToString()
        head.startsWith("#!") && head.lineSequence().first().contains("node")
    }
} catch (e: Exception) {
    LOG.warn("cannot inspect $path", e)
    false
}
