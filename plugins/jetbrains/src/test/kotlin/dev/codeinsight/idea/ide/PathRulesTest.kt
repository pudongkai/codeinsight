package dev.codeinsight.idea.ide

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class PathRulesTest {
    private val tmp: Path = Files.createTempDirectory("ci-paths").toRealPath()
    private val repo: Path = Files.createDirectories(tmp.resolve("repo"))
    private val outside: Path = Files.createDirectories(tmp.resolve("outside"))

    @After
    fun cleanup() {
        tmp.toFile().deleteRecursively()
    }

    private fun file(dir: Path, rel: String): Path {
        val p = dir.resolve(rel)
        Files.createDirectories(p.parent)
        return Files.writeString(p, "x")
    }

    @Test
    fun `openFile only accepts existing relative paths inside the repository`() {
        val a = file(repo, "pkg/a.py")
        val top = file(repo, "a.py")
        file(outside, "a.py")
        assertEquals(a, SourceNavigator.resolveInRepo(repo, "pkg/a.py"))
        assertEquals(top, SourceNavigator.resolveInRepo(repo, "pkg/../a.py"))
        assertNull(SourceNavigator.resolveInRepo(repo, "../outside/a.py"))
        assertNull(SourceNavigator.resolveInRepo(repo, outside.resolve("a.py").toString()))
        assertNull(SourceNavigator.resolveInRepo(repo, "pkg/missing.py"))
        assertNull(SourceNavigator.resolveInRepo(repo, ""))
        assertNull(SourceNavigator.resolveInRepo(repo, "."))
    }

    @Test
    fun `openFile rejects symbolic links inside the repository that point outside it`() {
        val secret = file(outside, ".ssh/id_rsa")
        Files.createSymbolicLink(repo.resolve("link"), secret.parent)
        Files.createSymbolicLink(repo.resolve("key"), secret)
        assertNull(SourceNavigator.resolveInRepo(repo, "link/id_rsa"))
        assertNull(SourceNavigator.resolveInRepo(repo, "key"))
    }

    @Test
    fun `openFile accepts links that stay inside the repository and keeps the path the IDE uses`() {
        val real = file(repo, "src/real.py")
        Files.createSymbolicLink(repo.resolve("alias.py"), real)
        assertEquals(repo.resolve("alias.py"), SourceNavigator.resolveInRepo(repo, "alias.py"))
        val repoLink = Files.createSymbolicLink(tmp.resolve("repo-link"), repo)
        assertEquals(repoLink.resolve("src/real.py"), SourceNavigator.resolveInRepo(repoLink, "src/real.py"))
    }

    @Test
    fun `data directory reported by serve needs exclusion only when it is inside the repository`() {
        val root = Path.of("/work/repo")
        assertTrue(DataDirExclusion.needsExclusion(root, Path.of("/work/repo/.codeinsight")))
        assertTrue(DataDirExclusion.needsExclusion(root, Path.of("/work/repo/build/ci")))
        assertFalse(DataDirExclusion.needsExclusion(root, Path.of("/tmp/ci")))
        assertFalse(DataDirExclusion.needsExclusion(root, Path.of("/work/repo-other")))
        assertFalse(DataDirExclusion.needsExclusion(root, root))
    }
}
