package dev.codeinsight.idea.ide

import dev.codeinsight.idea.CodeInsightService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class PathRulesTest {
    private val repo = Path.of("/work/repo")

    @Test
    fun `openFile only accepts relative paths inside the repository`() {
        assertEquals(Path.of("/work/repo/pkg/a.py"), SourceNavigator.resolveInRepo(repo, "pkg/a.py"))
        assertEquals(Path.of("/work/repo/a.py"), SourceNavigator.resolveInRepo(repo, "pkg/../a.py"))
        assertNull(SourceNavigator.resolveInRepo(repo, "../other/a.py"))
        assertNull(SourceNavigator.resolveInRepo(repo, "/etc/passwd"))
        assertNull(SourceNavigator.resolveInRepo(repo, ""))
        assertNull(SourceNavigator.resolveInRepo(repo, "."))
    }

    @Test
    fun `data directory is resolved like serve and only checked when inside the repository`() {
        assertEquals(Path.of("/work/repo/.codeinsight"), DataDirExclusion.dataDirInRepo(repo, null))
        assertEquals(Path.of("/work/repo/.codeinsight"), DataDirExclusion.dataDirInRepo(repo, "  "))
        assertEquals(Path.of("/work/repo/build/ci"), DataDirExclusion.dataDirInRepo(repo, "build/ci"))
        assertEquals(Path.of("/work/repo/x"), DataDirExclusion.dataDirInRepo(repo, "/work/repo/x"))
        assertNull(DataDirExclusion.dataDirInRepo(repo, "/tmp/ci"))
        assertNull(DataDirExclusion.dataDirInRepo(repo, "../ci"))
        assertNull(DataDirExclusion.dataDirInRepo(repo, "."))
    }

    @Test
    fun `repository root is the nearest ancestor with a git directory`() {
        val root = Files.createTempDirectory("ci-git")
        try {
            Files.createDirectories(root.resolve(".git"))
            val sub = Files.createDirectories(root.resolve("a/b"))
            assertEquals(root, CodeInsightService.findGitRoot(sub))
        } finally {
            root.toFile().deleteRecursively()
        }
    }
}
