package dev.codeinsight.idea.runtime

import com.intellij.openapi.diagnostic.logger
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.io.path.isDirectory

private val LOG = logger<SystemRuntimeProbe>()

/** 真实文件系统上的探测；`node --version` 用查找时的同一份环境运行（asdf / mise 的 shim 依赖环境变量） */
class SystemRuntimeProbe(private val env: Map<String, String>) : RuntimeProbe {
    override fun isExecutableFile(path: Path): Boolean = Files.isRegularFile(path) && Files.isExecutable(path)

    override fun subdirectories(dir: Path): List<Path> {
        if (!dir.isDirectory()) return emptyList()
        return Files.list(dir).use { s -> s.filter { it.isDirectory() }.toList() }
    }

    override fun nodeVersionOutput(node: Path): String? = try {
        val pb = ProcessBuilder(node.toString(), "--version").redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(env)
        val p = pb.start()
        p.outputStream.close()
        if (!p.waitFor(VERSION_TIMEOUT_S, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            LOG.warn("node --version timed out: $node")
            null
        } else {
            p.inputStream.bufferedReader().readText().trim().takeIf { p.exitValue() == 0 }
        }
    } catch (e: Exception) {
        LOG.warn("cannot run node --version: $node", e)
        null
    }

    private companion object {
        const val VERSION_TIMEOUT_S = 10L
    }
}
