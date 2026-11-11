package dev.codeinsight.idea.runtime

import dev.codeinsight.idea.serve.ServeCommand
import dev.codeinsight.idea.serve.ServeLaunchException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class CliEntryTest {
    private val root: Path = Files.createTempDirectory("ci-shim").toRealPath()

    @After
    fun cleanup() {
        root.toFile().deleteRecursively()
    }

    private fun write(rel: String, text: String): Path {
        val p = root.resolve(rel)
        Files.createDirectories(p.parent)
        return Files.writeString(p, text)
    }

    /** npm 全局安装生成的 shim（节选） */
    private val npmShim = """
        @ECHO off
        SETLOCAL
        CALL :find_dp0
        IF EXIST "%dp0%\node.exe" (
          SET "_prog=%dp0%\node.exe"
        ) ELSE (
          SET "_prog=node"
        )
        endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\codeinsight\dist\main.js" %*
    """.trimIndent()

    /** pnpm 生成的 shim（节选） */
    private val pnpmShim = """
        @SETLOCAL
        @IF EXIST "%~dp0\node.exe" (
          "%~dp0\node.exe"  "%~dp0\..\codeinsight\dist\main.js" %*
        ) ELSE (
          @SET PATHEXT=%PATHEXT:;.JS;=;%
          node  "%~dp0\..\codeinsight\dist\main.js" %*
        )
    """.trimIndent()

    @Test
    fun `npm cmd shim resolves to the JS entry next to it`() {
        val main = write("npm/node_modules/codeinsight/dist/main.js", "#!/usr/bin/env node\n")
        val shim = write("npm/codeinsight.cmd", npmShim)
        assertEquals(main, CmdShim.entryOf(shim))
    }

    @Test
    fun `pnpm cmd shim with a parent-relative path resolves too`() {
        val main = write("pnpm/codeinsight/dist/main.js", "")
        val shim = write("pnpm/bin/codeinsight.cmd", pnpmShim)
        assertEquals(main, CmdShim.entryOf(shim))
    }

    @Test
    fun `shim whose entry is missing or not recognisable gives no entry`() {
        assertNull(CmdShim.entryOf(write("a/codeinsight.cmd", npmShim)))
        assertNull(CmdShim.entryOf(write("b/codeinsight.cmd", "@echo off\r\ncodeinsight-real.exe %*\r\n")))
    }

    @Test
    fun `on Windows a cmd shim is launched as node plus main js, never through cmd`() {
        val main = write("npm dir & %USERPROFILE%/node_modules/codeinsight/dist/main.js", "")
        val shim = write("npm dir & %USERPROFILE%/codeinsight.cmd", npmShim)
        val program = resolveServeProgram(shim, windows = true)
        assertEquals(ServeProgram.NodeScript(main), program)

        val node = root.resolve("nodejs/node.exe")
        val repo = root.resolve("repo & %TEMP%")
        val home = root.resolve("home")
        val cmd = ServeCommand.build(node, program, repo, null, emptyMap(), home, windows = true)
        assertEquals(listOf(node.toString(), main.toString(), "serve", "--repo", repo.toString(), "--exit-on-stdin-close"), cmd.argv)
        assertFalse(cmd.argv.any { it.lowercase().endsWith(".cmd") || it.lowercase().contains("cmd.exe") })
        assertEquals(home, cmd.workDir)
        assertEquals("1", cmd.env["NoDefaultCurrentDirectoryInExePath"])
    }

    @Test
    fun `on Windows a cmd shim without a JS entry is an error instead of a cmd fallback`() {
        val shim = write("broken/codeinsight.cmd", "@echo off\r\n")
        val e = assertThrows(ServeLaunchException::class.java) { resolveServeProgram(shim, windows = true) }
        assertTrue(e.message!!.contains("main.js"))
    }

    @Test
    fun `node scripts run with node and other files run directly`() {
        val script = write("bin/codeinsight", "#!/usr/bin/env node\nimport './x.js'\n")
        assertEquals(ServeProgram.NodeScript(script), resolveServeProgram(script, windows = false))
        val js = write("lib/main.js", "")
        assertEquals(ServeProgram.NodeScript(js), resolveServeProgram(js, windows = true))
        val shell = write("shims/codeinsight", "#!/usr/bin/env bash\nexec x\n")
        assertEquals(ServeProgram.Executable(shell), resolveServeProgram(shell, windows = false))
        val exe = write("win/codeinsight.exe", "MZ")
        assertEquals(ServeProgram.Executable(exe), resolveServeProgram(exe, windows = true))
    }
}
