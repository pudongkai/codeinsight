package dev.codeinsight.idea.serve

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Path

class ServeInfoTest {
    private val token = "s3cr3t-T0ken_+/="

    @Test
    fun `parses the JSON line printed by serve`() {
        val info = ServeInfo.parse("""{"port":51234,"token":"$token","url":"http://127.0.0.1:51234/?token=x"}""" + "\n")
        assertEquals(51234, info.port)
        assertEquals("http://127.0.0.1:51234/", info.baseUrl)
        assertEquals("http://127.0.0.1:51234/?token=s3cr3t-T0ken_%2B%2F%3D", info.loginUrl)
    }

    @Test
    fun `toString and error messages never contain the token`() {
        val info = ServeInfo.parse("""{"port":1,"token":"$token","url":"u"}""")
        assertFalse(info.toString().contains(token))
        val e = assertThrows(ServeOutputException::class.java) { ServeInfo.parse("""{"port":"x","token":"$token","url":"u"}""") }
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
            """{"port":0,"token":"t","url":"u"}""",
            """{"port":70000,"token":"t","url":"u"}""",
            """{"port":12.5,"token":"t","url":"u"}""",
            """{"port":1,"token":"","url":"u"}""",
            """{"port":1,"url":"u"}""",
            """{"port":1,"token":"t"}""",
            """{"port":1,"token":{"a":1},"url":"u"}""",
        )
        for (line in bad) {
            assertThrows("should reject: $line", ServeOutputException::class.java) { ServeInfo.parse(line) }
        }
    }

    @Test
    fun `command runs the npm script with the located Node and puts its directory first on PATH`() {
        val node = Path.of("/Users/u/.nvm/versions/node/v22.14.0/bin/node")
        val ci = Path.of("/Users/u/.nvm/versions/node/v22.14.0/bin/codeinsight")
        val cmd = ServeCommand.build(node, ci, runWithNode = true, Path.of("/repo"), " /tmp/data ", mapOf("PATH" to "/usr/bin", "HOME" to "/Users/u"))
        assertEquals(listOf(node.toString(), ci.toString(), "serve", "--repo", "/repo", "--data-dir", "/tmp/data"), cmd.argv)
        assertTrue(cmd.env["PATH"]!!.startsWith("/Users/u/.nvm/versions/node/v22.14.0/bin"))
        assertTrue(cmd.env["PATH"]!!.endsWith("/usr/bin"))
        assertEquals("/Users/u", cmd.env["HOME"])

        val direct = ServeCommand.build(node, Path.of("/shims/codeinsight"), runWithNode = false, Path.of("/repo"), "", emptyMap())
        assertEquals(listOf("/shims/codeinsight", "serve", "--repo", "/repo"), direct.argv)
    }
}
