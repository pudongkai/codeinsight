package dev.codeinsight.idea.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Path

class RuntimeLocatorTest {
    private val home = Path.of("/Users/u")

    /** 假的文件系统：[executables] 里的路径存在且可执行，[versions] 是 `node --version` 的输出 */
    private class FakeProbe(
        val executables: Set<String>,
        val versions: Map<String, String> = emptyMap(),
        val dirs: Map<String, List<String>> = emptyMap(),
    ) : RuntimeProbe {
        val versionCalls = mutableListOf<String>()
        override fun isExecutableFile(path: Path) = path.toString() in executables
        override fun subdirectories(dir: Path) = dirs[dir.toString()].orEmpty().map { dir.resolve(it) }
        override fun nodeVersionOutput(node: Path): String? {
            versionCalls += node.toString()
            return versions[node.toString()]
        }
    }

    private fun ctx(nodeSetting: String? = null, ciSetting: String? = null, path: String? = null, env: Map<String, String> = emptyMap()) =
        LookupContext(nodeSetting, ciSetting, env + listOfNotNull(path?.let { "PATH" to it }), home, windows = false)

    private fun found(r: Lookup): Lookup.Found {
        assertTrue("expected Found but was $r", r is Lookup.Found)
        return r as Lookup.Found
    }

    @Test
    fun `node lookup order is settings, then PATH, then common directories`() {
        val c = RuntimeLocator(FakeProbe(emptySet())).nodeCandidates(ctx(nodeSetting = "/custom/node", path = "/env/bin:/usr/bin"))
        val list = c.map { it.path.toString() to it.origin }
        assertEquals("/custom/node" to Origin.SETTINGS, list[0])
        assertEquals("/env/bin/node" to Origin.PATH, list[1])
        assertEquals("/usr/bin/node" to Origin.PATH, list[2])
        assertEquals("/opt/homebrew/bin/node" to Origin.COMMON_DIR, list[3])
        assertEquals("/usr/local/bin/node" to Origin.COMMON_DIR, list[4])
        // /usr/bin 已经在 PATH 里出现过，不重复
        assertEquals(1, list.count { it.first == "/usr/bin/node" })
    }

    @Test
    fun `settings path wins when it is a usable node`() {
        val probe = FakeProbe(setOf("/custom/node", "/env/bin/node"), mapOf("/custom/node" to "v24.1.0", "/env/bin/node" to "v22.13.0"))
        val r = found(RuntimeLocator(probe).findNode(ctx(nodeSetting = "/custom/node", path = "/env/bin")))
        assertEquals(Path.of("/custom/node"), r.path)
        assertEquals(Origin.SETTINGS, r.origin)
        assertEquals(NodeVersion(24, 1, 0), r.version)
    }

    @Test
    fun `settings path supports tilde`() {
        val probe = FakeProbe(setOf("/Users/u/bin/node"), mapOf("/Users/u/bin/node" to "v22.13.0"))
        assertEquals(Path.of("/Users/u/bin/node"), found(RuntimeLocator(probe).findNode(ctx(nodeSetting = "~/bin/node"))).path)
    }

    @Test
    fun `falls through settings and PATH when versions are too old`() {
        val probe = FakeProbe(
            setOf("/custom/node", "/env/bin/node", "/opt/homebrew/bin/node"),
            mapOf("/custom/node" to "v20.11.0", "/env/bin/node" to "v22.12.9", "/opt/homebrew/bin/node" to "v22.13.0"),
        )
        val r = found(RuntimeLocator(probe).findNode(ctx(nodeSetting = "/custom/node", path = "/env/bin")))
        assertEquals(Path.of("/opt/homebrew/bin/node"), r.path)
        assertEquals(Origin.COMMON_DIR, r.origin)
        assertEquals(listOf("/custom/node", "/env/bin/node", "/opt/homebrew/bin/node"), probe.versionCalls)
    }

    @Test
    fun `GUI-launched IDE without Homebrew on PATH still finds nvm node, newest version first`() {
        val nvm = "/Users/u/.nvm/versions/node"
        val probe = FakeProbe(
            setOf("$nvm/v22.13.1/bin/node", "$nvm/v24.2.0/bin/node", "$nvm/v18.20.0/bin/node"),
            mapOf("$nvm/v22.13.1/bin/node" to "v22.13.1", "$nvm/v24.2.0/bin/node" to "v24.2.0", "$nvm/v18.20.0/bin/node" to "v18.20.0"),
            mapOf(nvm to listOf("v18.20.0", "v22.13.1", "v24.2.0", "not-a-version")),
        )
        val r = found(RuntimeLocator(probe).findNode(ctx(path = "/usr/bin:/bin")))
        assertEquals(Path.of("$nvm/v24.2.0/bin/node"), r.path)
    }

    @Test
    fun `NVM_DIR overrides the default nvm location`() {
        val probe = FakeProbe(setOf("/opt/nvm/versions/node/v22.20.0/bin/node"), mapOf("/opt/nvm/versions/node/v22.20.0/bin/node" to "v22.20.0"),
            mapOf("/opt/nvm/versions/node" to listOf("v22.20.0")))
        val r = found(RuntimeLocator(probe).findNode(ctx(env = mapOf("NVM_DIR" to "/opt/nvm"))))
        assertEquals(Path.of("/opt/nvm/versions/node/v22.20.0/bin/node"), r.path)
    }

    @Test
    fun `not found lists rejected candidates with reasons`() {
        val probe = FakeProbe(setOf("/usr/local/bin/node", "/usr/bin/node"), mapOf("/usr/local/bin/node" to "v20.0.0"))
        val r = RuntimeLocator(probe).findNode(ctx(nodeSetting = "/missing/node"))
        assertTrue(r is Lookup.NotFound)
        val reasons = (r as Lookup.NotFound).rejected.associate { it.path.toString() to it.reason }
        assertEquals("file not found or not executable", reasons["/missing/node"])
        assertEquals("version 20.0.0 < 22.13.0", reasons["/usr/local/bin/node"])
        assertEquals("`node --version` failed", reasons["/usr/bin/node"])
    }

    @Test
    fun `codeinsight lookup order is settings, node directory, PATH, common directories`() {
        val node = Path.of("/Users/u/.nvm/versions/node/v22.14.0/bin/node")
        val c = RuntimeLocator(FakeProbe(emptySet())).codeinsightCandidates(ctx(ciSetting = "/ci/codeinsight", path = "/env/bin"), node)
        assertEquals(
            listOf(
                "/ci/codeinsight" to Origin.SETTINGS,
                "/Users/u/.nvm/versions/node/v22.14.0/bin/codeinsight" to Origin.NODE_DIR,
                "/env/bin/codeinsight" to Origin.PATH,
                "/opt/homebrew/bin/codeinsight" to Origin.COMMON_DIR,
            ),
            c.take(4).map { it.path.toString() to it.origin },
        )
        val probe = FakeProbe(setOf("/Users/u/.nvm/versions/node/v22.14.0/bin/codeinsight", "/env/bin/codeinsight"))
        val r = found(RuntimeLocator(probe).findCodeInsight(ctx(path = "/env/bin"), node))
        assertEquals(Origin.NODE_DIR, r.origin)
    }

    @Test
    fun `windows uses exe and cmd names and the semicolon PATH separator`() {
        val ctx = LookupContext(null, null, mapOf("Path" to "C:\\a;C:\\b", "ProgramFiles" to "C:\\Program Files"), home, windows = true)
        val names = RuntimeLocator(FakeProbe(emptySet())).nodeCandidates(ctx).map { it.path.fileName.toString() }.toSet()
        assertEquals(setOf("node.exe"), names)
    }

    @Test
    fun `version parsing`() {
        assertEquals(NodeVersion(22, 13, 0), NodeVersion.parse("v22.13.0\n"))
        assertNull(NodeVersion.parse("node: command not found"))
        assertTrue(NodeVersion(22, 13, 0) > NodeVersion(22, 12, 99))
    }
}
