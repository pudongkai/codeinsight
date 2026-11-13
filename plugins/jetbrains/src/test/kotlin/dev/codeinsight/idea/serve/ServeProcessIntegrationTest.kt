package dev.codeinsight.idea.serve

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import dev.codeinsight.idea.runtime.ServeProgram
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 用本仓库构建出的 cli（packages/cli/dist/main.js）真实启动 serve：解析 stdout（含仓库根目录和数据目录）、token 换 cookie、
 * 仓库锁定（--lock-repo）、同步和异步停止后退出；以及旧版 CLI 不认识 --lock-repo 时去掉参数重启。
 * serve 用临时的 CODEINSIGHT_HOME，不读写本机的用户设置和最近仓库列表。
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

    private lateinit var settingsHome: Path

    private fun withRepo(block: (repo: Path, data: Path) -> Unit) {
        val repo = Files.createTempDirectory("ci-plugin-repo")
        val data = Files.createTempDirectory("ci-plugin-data")
        settingsHome = Files.createTempDirectory("ci-plugin-home")
        try {
            git(repo, "init", "-q")
            Files.writeString(repo.resolve("a.py"), "def f():\n    return 1\n")
            block(repo, data)
        } finally {
            repo.toFile().deleteRecursively()
            data.toFile().deleteRecursively()
            settingsHome.toFile().deleteRecursively()
        }
    }

    private fun command(node: Path, repo: Path, data: Path?, settingsHome: Path, program: Path = cli): ServeCommand {
        val home = Path.of(System.getProperty("user.home"))
        val env = System.getenv() + mapOf("CODEINSIGHT_HOME" to settingsHome.toString())
        return ServeCommand.build(node, ServeProgram.NodeScript(program), repo, data?.toString(), env, home, windows = false)
    }

    private fun tokenOf(serve: ServeProcess): String =
        URLDecoder.decode(serve.info.loginUrl.substringAfter("?token="), StandardCharsets.UTF_8)

    /** 带 Bearer token 发请求，返回状态码和响应体 */
    private fun call(serve: ServeProcess, method: String, path: String, body: String? = null): Pair<Int, String> {
        val c = URI("${serve.info.baseUrl}$path").toURL().openConnection() as HttpURLConnection
        c.requestMethod = method
        c.setRequestProperty("Authorization", "Bearer ${tokenOf(serve)}")
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        return try {
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            code to (stream?.use { String(it.readAllBytes()) } ?: "")
        } finally {
            c.disconnect()
        }
    }

    private fun jsonString(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    @Test
    fun `starts real serve, parses its address, repo and data directory, and stops it with SIGTERM`() {
        val node = requireRuntime()
        withRepo { repo, data ->
            val sub = Files.createDirectories(repo.resolve("sub"))
            val serve = ServeProcess.start(command(node, sub, data, settingsHome))
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
            val serve = ServeProcess.start(command(node, repo, data, settingsHome))
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

    @Test
    fun `serve started by the plugin locks the repository`() {
        val node = requireRuntime()
        withRepo { repo, data ->
            val other = Files.createTempDirectory("ci-plugin-other")
            try {
                git(other, "init", "-q")
                val serve = ServeProcess.start(command(node, repo, data, settingsHome))
                try {
                    val (code, status) = call(serve, "GET", "api/status")
                    assertEquals(200, code)
                    assertTrue(status, status.contains("\"repoLocked\":true"))
                    val (switchCode, switchBody) = call(serve, "POST", "api/repo", "{\"path\":${jsonString(other.toString())}}")
                    assertEquals(409, switchCode)
                    assertTrue(switchBody, switchBody.contains("\"error\":\"repo_locked\""))
                } finally {
                    serve.stop()
                }
                assertFalse(serve.isAlive)
            } finally {
                other.toFile().deleteRecursively()
            }
        }
    }

    @Test
    fun `an older CLI that rejects --lock-repo is restarted without it`() {
        val node = requireRuntime()
        withRepo { repo, data ->
            val argsFile = data.resolve("args.txt")
            val fake = data.resolve("old-cli.mjs")
            Files.writeString(
                fake,
                """
                import { appendFileSync } from 'node:fs';
                const args = process.argv.slice(2);
                appendFileSync(${jsonString(argsFile.toString())}, args.join(' ') + '\n');
                if (args.includes('--lock-repo')) {
                  process.stderr.write("error: Unknown option '--lock-repo'. To specify a positional argument starting with a '-', place it at the end\n");
                  process.exit(1);
                }
                const info = { port: 45678, token: 't', url: 'http://127.0.0.1:45678/?token=t', repo: ${jsonString(repo.toString())}, dataDir: ${jsonString(data.toString())} };
                process.stdout.write(JSON.stringify(info) + '\n');
                process.stdin.resume();
                process.stdin.on('end', () => process.exit(0));
                process.on('SIGTERM', () => process.exit(0));
                """.trimIndent(),
            )
            val serve = ServeProcess.start(command(node, repo, data, settingsHome, program = fake))
            try {
                assertEquals(45678, serve.info.port)
                val runs = Files.readAllLines(argsFile)
                assertEquals(2, runs.size)
                assertTrue(runs[0], runs[0].contains("--lock-repo"))
                assertFalse(runs[1], runs[1].contains("--lock-repo"))
            } finally {
                serve.stop()
            }
            assertFalse(serve.isAlive)
        }
    }
}
