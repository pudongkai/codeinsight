package dev.codeinsight.idea.serve

import com.intellij.openapi.diagnostic.logger
import com.intellij.util.concurrency.AppExecutorUtil
import dev.codeinsight.idea.runtime.ServeProgram
import java.io.BufferedReader
import java.io.File
import java.nio.file.Path
import java.util.ArrayDeque
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread

private val LOG = logger<ServeProcess>()

/** 启动 serve 的命令行、环境和工作目录 */
data class ServeCommand(val argv: List<String>, val env: Map<String, String>, val workDir: Path) {
    fun withoutLockRepo(): ServeCommand = copy(argv = argv.filter { it != LOCK_REPO })

    companion object {
        /**
         * JS 入口用找到的 Node 直接运行，不依赖 PATH 里的 node，也不经过 cmd.exe（cmd 会解释路径里的 `&`、`%VAR%`）；
         * 其他可执行文件（版本管理器的 shim、.exe）直接执行。PATH 前面加上 Node 所在目录，serve 再起的子进程也用这个 Node。
         * 工作目录用 [workDir]（用户主目录）而不是仓库：Windows 按名字找程序时会先找当前目录，仓库里的同名程序不能被执行。
         * `--exit-on-stdin-close` 让 serve 在插件进程消失（stdin 管道关闭）时自行退出。
         * `--lock-repo` 锁定项目所在仓库：插件按项目目录打开文件、审查工作区，网页里不能切换到别的仓库。
         */
        fun build(
            node: Path,
            program: ServeProgram,
            repo: Path,
            dataDir: String?,
            env: Map<String, String>,
            workDir: Path,
            windows: Boolean,
        ): ServeCommand {
            val launcher = when (program) {
                is ServeProgram.NodeScript -> listOf(node.toString(), program.script.toString())
                is ServeProgram.Executable -> listOf(program.path.toString())
            }
            val args = mutableListOf("serve", "--repo", repo.toString(), LOCK_REPO, "--exit-on-stdin-close")
            if (!dataDir.isNullOrBlank()) args += listOf("--data-dir", dataDir.trim())
            return ServeCommand(launcher + args, childEnv(node, env, windows), workDir)
        }

        const val LOCK_REPO = "--lock-repo"

        /**
         * serve 因为不认识 `--lock-repo` 而退出（旧版 CLI 的参数解析报 unknown option）。
         * 旧版 CLI 本来就不能切换仓库，去掉这个参数重启没有影响。
         */
        fun rejectsLockRepo(stderrTail: List<String>): Boolean =
            stderrTail.any { it.contains("unknown option", ignoreCase = true) && it.contains(LOCK_REPO) }

        private fun childEnv(node: Path, env: Map<String, String>, windows: Boolean): Map<String, String> {
            val pathKey = env.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH"
            val nodeDir = node.parent?.toString()
            val newEnv = env.toMutableMap()
            if (nodeDir != null) newEnv[pathKey] = listOfNotNull(nodeDir, env[pathKey]).joinToString(File.pathSeparator)
            // serve 再起的子进程按名字找程序时不搜索当前目录
            if (windows) newEnv["NoDefaultCurrentDirectoryInExePath"] = "1"
            return newEnv
        }
    }
}

/** serve 启动失败：退出码和 stderr 最后几行显示在工具窗口里 */
class ServeLaunchException(message: String, val stderrTail: List<String>) : Exception(message)

/**
 * 正在运行的 `codeinsight serve` 进程。stdout 第一行是地址和 token（只交给 [ServeInfo]，不打日志），
 * stderr 是 serve 的日志，转到 IDE 日志的 debug 级别并保留最后几行。
 * stdin 管道一直保持打开：IDE 崩溃或被强杀时管道随之关闭，serve 读到 EOF 后自行清理退出。
 */
class ServeProcess private constructor(private val process: Process, val info: ServeInfo, private val stderr: StderrTail) {
    val pid: Long get() = process.pid()
    val isAlive: Boolean get() = process.isAlive

    fun stderrTail(): List<String> = stderr.lines()

    /** 进程退出时回调退出码（在后台线程上） */
    fun onExit(callback: (Int) -> Unit) {
        process.onExit().thenAccept { callback(it.exitValue()) }
    }

    /** 请求 serve 退出（serve 会结束 scip-python 子进程再退出），等到超时后强杀进程和它的子进程。会阻塞，不要在 EDT 上调用 */
    fun stop() = stopBlocking(process)

    /**
     * 只发出退出请求就返回，超时后的强杀放到 [scheduler] 上，可以在 EDT 上调用（项目关闭时）。
     * IDE 退出时 JVM 可能等不到强杀，这时 serve 已收到 SIGTERM，stdin 管道也会随 IDE 进程关闭，serve 仍会退出。
     */
    fun stopAsync(scheduler: ScheduledExecutorService = AppExecutorUtil.getAppScheduledExecutorService()) {
        val descendants = requestExit(process) ?: return
        scheduler.schedule({ forceKill(process, descendants) }, STOP_TIMEOUT_S, TimeUnit.SECONDS)
    }

    companion object {
        private const val START_TIMEOUT_S = 60L
        private const val STOP_TIMEOUT_S = 6L
        private const val TAIL_LINES = 20

        /** 启动 serve；旧版 CLI 不认识 `--lock-repo` 而退出时，去掉这个参数再启动一次 */
        fun start(cmd: ServeCommand): ServeProcess = try {
            launch(cmd)
        } catch (e: ServeLaunchException) {
            if (ServeCommand.LOCK_REPO !in cmd.argv || !ServeCommand.rejectsLockRepo(e.stderrTail)) throw e
            LOG.warn("serve does not support ${ServeCommand.LOCK_REPO} (older codeinsight CLI), restarting without it")
            launch(cmd.withoutLockRepo())
        }

        private fun launch(cmd: ServeCommand): ServeProcess {
            val pb = ProcessBuilder(cmd.argv).directory(cmd.workDir.toFile())
            pb.environment().clear()
            pb.environment().putAll(cmd.env)
            val process = pb.start()
            val stderr = StderrTail(process.errorReader(), TAIL_LINES)
            LOG.info("serve process started: pid=${process.pid()} command=${cmd.argv.joinToString(" ")}")
            val info = try {
                readInfo(process)
            } catch (e: ServeLaunchException) {
                stopBlocking(process)
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

        private fun stopBlocking(process: Process) {
            val descendants = requestExit(process) ?: return
            process.waitFor(STOP_TIMEOUT_S, TimeUnit.SECONDS)
            forceKill(process, descendants)
        }

        /**
         * 关闭 stdin 并发 SIGTERM，两者都会让 serve 走同一套清理流程。返回此刻的子孙进程：
         * 父进程退出后它们会被收养，提前记下才能在强杀时一起处理。进程已退出时返回 null。
         */
        private fun requestExit(process: Process): List<ProcessHandle>? {
            if (!process.isAlive) return null
            val descendants = process.descendants().toList()
            LOG.info("stopping serve: pid=${process.pid()} (SIGTERM)")
            try {
                process.outputStream.close()
            } catch (_: java.io.IOException) {
                // 管道已断开说明 serve 已在退出
            }
            process.destroy()
            return descendants
        }

        private fun forceKill(process: Process, descendants: List<ProcessHandle>) {
            if (process.isAlive) {
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
