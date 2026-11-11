package dev.codeinsight.idea.serve

import com.intellij.openapi.diagnostic.logger
import java.io.BufferedReader
import java.io.File
import java.nio.file.Path
import java.util.ArrayDeque
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread

private val LOG = logger<ServeProcess>()

/** 启动 serve 的命令行和环境 */
data class ServeCommand(val argv: List<String>, val env: Map<String, String>, val workDir: Path) {
    companion object {
        /**
         * npm 安装的 `codeinsight` 是带 `#!/usr/bin/env node` 的脚本，用找到的 Node 直接运行它，不依赖 PATH 里的 node；
         * 其他形式（Windows 的 .cmd、版本管理器的 shim）直接执行。PATH 前面加上 Node 所在目录，serve 再起的子进程也用这个 Node。
         */
        fun build(node: Path, codeinsight: Path, runWithNode: Boolean, repo: Path, dataDir: String?, env: Map<String, String>): ServeCommand {
            val launcher = if (runWithNode) listOf(node.toString(), codeinsight.toString()) else listOf(codeinsight.toString())
            val args = mutableListOf("serve", "--repo", repo.toString())
            if (!dataDir.isNullOrBlank()) args += listOf("--data-dir", dataDir.trim())
            val pathKey = env.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH"
            val nodeDir = node.parent?.toString()
            val newEnv = env.toMutableMap()
            if (nodeDir != null) newEnv[pathKey] = listOfNotNull(nodeDir, env[pathKey]).joinToString(File.pathSeparator)
            return ServeCommand(launcher + args, newEnv, repo)
        }
    }
}

/** serve 启动失败：退出码和 stderr 最后几行显示在工具窗口里 */
class ServeLaunchException(message: String, val stderrTail: List<String>) : Exception(message)

/**
 * 正在运行的 `codeinsight serve` 进程。stdout 第一行是地址和 token（只交给 [ServeInfo]，不打日志），
 * stderr 是 serve 的日志，转到 IDE 日志的 debug 级别并保留最后几行。
 */
class ServeProcess private constructor(private val process: Process, val info: ServeInfo, private val stderr: StderrTail) {
    val pid: Long get() = process.pid()
    val isAlive: Boolean get() = process.isAlive

    fun stderrTail(): List<String> = stderr.lines()

    /** 进程退出时回调退出码（在后台线程上） */
    fun onExit(callback: (Int) -> Unit) {
        process.onExit().thenAccept { callback(it.exitValue()) }
    }

    /** 先发 SIGTERM（serve 会结束 scip-python 子进程再退出），超时后强杀进程和它的子进程 */
    fun stop() = terminate(process)

    companion object {
        private const val START_TIMEOUT_S = 60L
        private const val STOP_TIMEOUT_S = 6L
        private const val TAIL_LINES = 20

        fun start(cmd: ServeCommand): ServeProcess {
            val pb = ProcessBuilder(cmd.argv).directory(cmd.workDir.toFile())
            pb.environment().clear()
            pb.environment().putAll(cmd.env)
            val process = pb.start()
            process.outputStream.close()
            val stderr = StderrTail(process.errorReader(), TAIL_LINES)
            LOG.info("serve process started: pid=${process.pid()} command=${cmd.argv.joinToString(" ")}")
            val info = try {
                readInfo(process)
            } catch (e: ServeLaunchException) {
                terminate(process)
                stderr.awaitEnd()
                throw ServeLaunchException(e.message ?: "serve failed to start", stderr.lines())
            }
            LOG.info("serve ready: pid=${process.pid()} url=${info.baseUrl}")
            drainStdout(process.inputReader())
            return ServeProcess(process, info, stderr)
        }

        private fun readInfo(process: Process): ServeInfo {
            val reader = process.inputReader()
            val firstLine = CompletableFuture.supplyAsync { reader.readLine() }
            val line = try {
                firstLine.get(START_TIMEOUT_S, TimeUnit.SECONDS)
            } catch (_: TimeoutException) {
                throw ServeLaunchException("serve did not print its address within $START_TIMEOUT_S s", emptyList())
            } catch (e: ExecutionException) {
                throw ServeLaunchException("cannot read serve output: ${e.cause?.message}", emptyList())
            }
            if (line == null) {
                val code = if (process.waitFor(2, TimeUnit.SECONDS)) process.exitValue().toString() else "unknown"
                throw ServeLaunchException("serve exited with code $code before printing its address", emptyList())
            }
            return try {
                ServeInfo.parse(line)
            } catch (e: ServeOutputException) {
                throw ServeLaunchException(e.message ?: "invalid serve output", emptyList())
            }
        }

        private fun drainStdout(reader: BufferedReader) {
            thread(name = "codeinsight-serve-stdout", isDaemon = true) {
                reader.useLines { lines -> lines.forEach { LOG.debug("serve stdout: $it") } }
            }
        }

        private fun terminate(process: Process) {
            if (!process.isAlive) return
            // 父进程退出后子进程会被收养，提前记下才能在强杀时一起处理
            val descendants = process.descendants().toList()
            LOG.info("stopping serve: pid=${process.pid()} (SIGTERM)")
            process.destroy()
            if (!process.waitFor(STOP_TIMEOUT_S, TimeUnit.SECONDS)) {
                LOG.warn("serve did not exit within $STOP_TIMEOUT_S s after SIGTERM, killing: pid=${process.pid()}")
                process.destroyForcibly()
                process.waitFor(2, TimeUnit.SECONDS)
            }
            descendants.filter { it.isAlive }.forEach {
                LOG.warn("killing leftover serve child process: pid=${it.pid()}")
                it.destroyForcibly()
            }
        }
    }
}

/** 读 serve 的 stderr：逐行写 debug 日志，保留最后 [size] 行 */
private class StderrTail(reader: BufferedReader, private val size: Int) {
    private val tail = ArrayDeque<String>()
    private val worker = thread(name = "codeinsight-serve-stderr", isDaemon = true) {
        reader.useLines { lines ->
            lines.forEach { line ->
                LOG.debug("serve: $line")
                synchronized(tail) {
                    tail.addLast(line)
                    if (tail.size > size) tail.removeFirst()
                }
            }
        }
    }

    fun lines(): List<String> = synchronized(tail) { tail.toList() }

    fun awaitEnd() = worker.join(2000)
}
