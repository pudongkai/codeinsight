package dev.codeinsight.idea.serve

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import dev.codeinsight.idea.runtime.ServeProgram
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 用本仓库构建出的 cli（packages/cli/dist/main.js）真实启动 serve：解析 stdout（含仓库根目录和数据目录）、token 换 cookie、
 * 同步和异步停止后退出。
 * 本机没有 node 或没有先运行 `pnpm -r build` 时跳过。
 */
class ServeProcessIntegrationTest {
    private val cli = Path.of(System.getProperty("user.dir")).resolve("../../packages/cli/dist/main.js").normalize()

    private fun findNode(): Path? = System.getenv("PATH").orEmpty().split(':')
        .map { Path.of(it, "node") }.firstOrNull { Files.isExecutable(it) }

    private fun git(dir: Path, vararg args: String) {
        val p = ProcessBuilder(listOf("git", "-C", dir.toString()) + args).redirectErrorStream(true).start()
        p.inputStream.readAllBytes()
        check(p.waitFor(30, TimeUnit.SECONDS) && p.exitValue() == 0) { "git ${args.toList()} failed" }
    }

    private fun status(url: String): Int {
        val c = URI(url).toURL().openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false
        return try { c.responseCode } finally { c.disconnect() }
    }

    private fun requireRuntime(): Path {
        val node = findNode()
        assumeTrue("node not on PATH", node != null)
        assumeTrue("cli not built: $cli", Files.isRegularFile(cli))
        return node!!
    }

    private fun withRepo(block: (repo: Path, data: Path) -> Unit) {
        val repo = Files.createTempDirectory("ci-plugin-repo")
        val data = Files.createTempDirectory("ci-plugin-data")
        try {
            git(repo, "init", "-q")
            Files.writeString(repo.resolve("a.py"), "def f():\n    return 1\n")
            block(repo, data)
        } finally {
            repo.toFile().deleteRecursively()
            data.toFile().deleteRecursively()
        }
    }

    private fun command(node: Path, repo: Path, data: Path?): ServeCommand {
        val home = Path.of(System.getProperty("user.home"))
        return ServeCommand.build(node, ServeProgram.NodeScript(cli), repo, data?.toString(), System.getenv(), home, windows = false)
    }

    @Test
    fun `starts real serve, parses its address, repo and data directory, and stops it with SIGTERM`() {
        val node = requireRuntime()
        withRepo { repo, data ->
            val sub = Files.createDirectories(repo.resolve("sub"))
            val serve = ServeProcess.start(command(node, sub, data))
            try {
                assertEquals(repo.toRealPath(), serve.info.repo)
                assertEquals(data, serve.info.dataDir)
                assertEquals(401, status("${serve.info.baseUrl}api/status"))
                assertEquals(302, status(serve.info.loginUrl))
            } finally {
                serve.stop()
            }
            assertFalse(serve.isAlive)
        }
    }

    @Test
    fun `stopAsync returns at once and serve still exits`() {
        val node = requireRuntime()
        withRepo { repo, data ->
            val serve = ServeProcess.start(command(node, repo, data))
            val scheduler = Executors.newSingleThreadScheduledExecutor()
            try {
                val started = System.nanoTime()
                serve.stopAsync(scheduler)
                assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 1000)
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (serve.isAlive && System.nanoTime() < deadline) Thread.sleep(50)
                assertFalse(serve.isAlive)
            } finally {
                scheduler.shutdownNow()
                serve.stop()
            }
        }
    }
}
