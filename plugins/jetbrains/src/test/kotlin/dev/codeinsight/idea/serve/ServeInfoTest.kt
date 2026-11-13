package dev.codeinsight.idea.serve

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import dev.codeinsight.idea.runtime.ServeProgram
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class ServeInfoTest {
    private val token = "s3cr3t-T0ken_+/="
    private val paths = """"repo":"/work/repo","dataDir":"/data/ci/""""

    @Test
    fun `parses the JSON line printed by serve`() {
        val info = ServeInfo.parse("""{"port":51234,"token":"$token","url":"http://127.0.0.1:51234/?token=x",$paths}""" + "\n")
        assertEquals(51234, info.port)
        assertEquals(Path.of("/work/repo"), info.repo)
        assertEquals(Path.of("/data/ci"), info.dataDir)
        assertEquals("http://127.0.0.1:51234/", info.baseUrl)
        assertEquals("http://127.0.0.1:51234/?token=s3cr3t-T0ken_%2B%2F%3D", info.loginUrl)
    }

    @Test
    fun `toString and error messages never contain the token`() {
        val info = ServeInfo.parse("""{"port":1,"token":"$token","url":"u",$paths}""")
        assertFalse(info.toString().contains(token))
        val e = assertThrows(ServeOutputException::class.java) { ServeInfo.parse("""{"port":"x","token":"$token","url":"u",$paths}""") }
        assertFalse(e.message!!.contains(token))
    }

    @Test
    fun `rejects output that is not the expected JSON object`() {
        val bad = listOf(
            null,
            "",
            "   ",
            "warning: pyrightconfig.json exclude",
            "[1,2]",
            """{"port":0,"token":"t","url":"u",$paths}""",
            """{"port":70000,"token":"t","url":"u",$paths}""",
            """{"port":12.5,"token":"t","url":"u",$paths}""",
            """{"port":1,"token":"","url":"u",$paths}""",
            """{"port":1,"url":"u",$paths}""",
            """{"port":1,"token":"t",$paths}""",
            """{"port":1,"token":{"a":1},"url":"u",$paths}""",
            """{"port":1,"token":"t","url":"u"}""",
            """{"port":1,"token":"t","url":"u","repo":"/r"}""",
            """{"port":1,"token":"t","url":"u","repo":"relative/r","dataDir":"/d"}""",
            """{"port":1,"token":"t","url":"u","repo":"/r","dataDir":""}""",
        )
        for (line in bad) {
            assertThrows("should reject: $line", ServeOutputException::class.java) { ServeInfo.parse(line) }
        }
    }

    @Test
    fun `command runs the npm script with the located Node, asks serve to exit with stdin, and runs outside the repository`() {
        val node = Path.of("/Users/u/.nvm/versions/node/v22.14.0/bin/node")
        val ci = Path.of("/Users/u/.nvm/versions/node/v22.14.0/bin/codeinsight")
        val home = Path.of("/Users/u")
        val env = mapOf("PATH" to "/usr/bin", "HOME" to "/Users/u")
        val cmd = ServeCommand.build(node, ServeProgram.NodeScript(ci), Path.of("/repo"), " /tmp/data ", env, home, windows = false)
        assertEquals(
            listOf(node.toString(), ci.toString(), "serve", "--repo", "/repo", "--lock-repo", "--exit-on-stdin-close", "--data-dir", "/tmp/data"),
            cmd.argv,
        )
        assertTrue(cmd.env["PATH"]!!.startsWith("/Users/u/.nvm/versions/node/v22.14.0/bin"))
        assertTrue(cmd.env["PATH"]!!.endsWith("/usr/bin"))
        assertEquals("/Users/u", cmd.env["HOME"])
        assertEquals(home, cmd.workDir)
        assertFalse(cmd.env.containsKey("NoDefaultCurrentDirectoryInExePath"))

        val direct = ServeCommand.build(node, ServeProgram.Executable(Path.of("/shims/codeinsight")), Path.of("/repo"), "", emptyMap(), home, windows = false)
        assertEquals(listOf("/shims/codeinsight", "serve", "--repo", "/repo", "--lock-repo", "--exit-on-stdin-close"), direct.argv)
    }

    @Test
    fun `windows command keeps PATH casing and stops cmd from searching the current directory`() {
        val node = Path.of("/nodejs/node.exe")
        val env = mapOf("Path" to "/windows/system32")
        val cmd = ServeCommand.build(node, ServeProgram.NodeScript(Path.of("/npm/main.js")), Path.of("/repo"), null, env, Path.of("/home"), windows = true)
        assertEquals("1", cmd.env["NoDefaultCurrentDirectoryInExePath"])
        assertTrue(cmd.env["Path"]!!.startsWith("/nodejs"))
        assertFalse(cmd.env.containsKey("PATH"))
    }

    @Test
    fun `paths from serve are mapped back onto the project path when the project is opened through a symbolic link`() {
        val tmp = Files.createTempDirectory("ci-info").toRealPath()
        try {
            val repo = Files.createDirectories(tmp.resolve("repo/sub"))!!.parent
            val link = Files.createSymbolicLink(tmp.resolve("link"), repo)
            fun info(dataDir: Path) = ServeInfo.parse(
                """{"port":1,"token":"t","url":"u","repo":"$repo","dataDir":"$dataDir"}""",
            )
            val inside = info(repo.resolve(".codeinsight")).localizedTo(link.resolve("sub"))
            assertEquals(link, inside.repo)
            assertEquals(link.resolve(".codeinsight"), inside.dataDir)
            val outside = info(Path.of("/data/ci")).localizedTo(link)
            assertEquals(Path.of("/data/ci"), outside.dataDir)
            val unrelated = info(repo.resolve(".codeinsight")).localizedTo(tmp)
            assertEquals(repo, unrelated.repo)
            assertEquals(repo, info(Path.of("/d")).localizedTo(repo).repo)
        } finally {
            tmp.toFile().deleteRecursively()
        }
    }
}
