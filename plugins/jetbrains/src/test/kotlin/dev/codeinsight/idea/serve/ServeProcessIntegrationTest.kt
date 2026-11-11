package dev.codeinsight.idea.serve

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * 用本仓库构建出的 cli（packages/cli/dist/main.js）真实启动 serve：解析 stdout、token 换 cookie、SIGTERM 后退出。
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

    @Test
    fun `starts real serve, parses its address and stops it with SIGTERM`() {
        val node = findNode()
        assumeTrue("node not on PATH", node != null)
        assumeTrue("cli not built: $cli", Files.isRegularFile(cli))
        val repo = Files.createTempDirectory("ci-plugin-repo")
        val data = Files.createTempDirectory("ci-plugin-data")
        try {
            git(repo, "init", "-q")
            Files.writeString(repo.resolve("a.py"), "def f():\n    return 1\n")
            val cmd = ServeCommand.build(node!!, cli, runWithNode = true, repo, data.toString(), System.getenv())
            val serve = ServeProcess.start(cmd)
            try {
                assertEquals(401, status("${serve.info.baseUrl}api/status"))
                assertEquals(302, status(serve.info.loginUrl))
            } finally {
                serve.stop()
            }
            assertFalse(serve.isAlive)
        } finally {
            repo.toFile().deleteRecursively()
            data.toFile().deleteRecursively()
        }
    }
}
