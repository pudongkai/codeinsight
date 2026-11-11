package dev.codeinsight.idea.runtime

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import dev.codeinsight.idea.serve.ServeCommand
import dev.codeinsight.idea.settings.CodeInsightSettings
import java.nio.file.Files
import java.nio.file.Path

private val LOG = logger<RuntimeLocator>()

/** 找不到能用的 Node 或 codeinsight，工具窗口据此显示安装指引 */
sealed interface MissingRuntime {
    data class Node(val rejected: List<Rejected>) : MissingRuntime
    data class CodeInsight(val node: Path, val rejected: List<Rejected>) : MissingRuntime
}

sealed interface Resolution {
    data class Ready(val command: ServeCommand) : Resolution
    data class Missing(val what: MissingRuntime) : Resolution
}

/**
 * 按 [RuntimeLocator] 的顺序找到 Node 和 codeinsight，拼出启动 serve 的命令。
 * `EnvironmentUtil.getEnvironmentMap()` 在 macOS 上要等登录 shell 环境加载完，不能在 EDT 上调用。
 */
fun resolveServeCommand(repo: Path, dataDir: String?): Resolution {
    val settings = CodeInsightSettings.getInstance().state
    val env = EnvironmentUtil.getEnvironmentMap()
    val ctx = LookupContext(settings.nodePath, settings.codeinsightPath, env, Path.of(System.getProperty("user.home")), SystemInfo.isWindows)
    val locator = RuntimeLocator(SystemRuntimeProbe(env))
    val node = when (val r = locator.findNode(ctx)) {
        is Lookup.NotFound -> {
            LOG.warn("Node >= ${NodeVersion.MINIMUM} not found; rejected: ${r.rejected}")
            return Resolution.Missing(MissingRuntime.Node(r.rejected))
        }
        is Lookup.Found -> r
    }
    LOG.info("using Node ${node.version} at ${node.path} (from ${node.origin})")
    val ci = when (val r = locator.findCodeInsight(ctx, node.path)) {
        is Lookup.NotFound -> {
            LOG.warn("codeinsight not found; rejected: ${r.rejected}")
            return Resolution.Missing(MissingRuntime.CodeInsight(node.path, r.rejected))
        }
        is Lookup.Found -> r
    }
    LOG.info("using codeinsight at ${ci.path} (from ${ci.origin})")
    return Resolution.Ready(ServeCommand.build(node.path, ci.path, isNodeScript(ci.path), repo, dataDir, env))
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
