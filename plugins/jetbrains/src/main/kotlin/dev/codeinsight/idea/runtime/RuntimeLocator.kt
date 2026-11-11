package dev.codeinsight.idea.runtime

import java.nio.file.InvalidPathException
import java.nio.file.Path

/** Node 版本号，只比较 major.minor.patch */
data class NodeVersion(val major: Int, val minor: Int, val patch: Int) : Comparable<NodeVersion> {
    override fun compareTo(other: NodeVersion): Int =
        compareValuesBy(this, other, NodeVersion::major, NodeVersion::minor, NodeVersion::patch)

    override fun toString(): String = "$major.$minor.$patch"

    companion object {
        /** codeinsight 依赖的 `node:sqlite` 从这个版本起不需要命令行开关 */
        val MINIMUM = NodeVersion(22, 13, 0)
        private val PATTERN = Regex("""v?(\d+)\.(\d+)\.(\d+)""")

        fun parse(text: String?): NodeVersion? {
            val m = text?.trim()?.let { PATTERN.matchEntire(it) } ?: return null
            val (a, b, c) = m.destructured
            return NodeVersion(a.toInt(), b.toInt(), c.toInt())
        }
    }
}

/** 候选路径的来源，按查找顺序排列 */
enum class Origin { SETTINGS, NODE_DIR, PATH, COMMON_DIR }

data class Candidate(val path: Path, val origin: Origin)

/** 查找过但不能用的候选及原因，显示在安装指引里 */
data class Rejected(val path: Path, val reason: String)

sealed interface Lookup {
    data class Found(val path: Path, val origin: Origin, val version: NodeVersion? = null) : Lookup
    data class NotFound(val rejected: List<Rejected>) : Lookup
}

/** 文件系统和进程探测，单测里替换 */
interface RuntimeProbe {
    fun isExecutableFile(path: Path): Boolean
    fun subdirectories(dir: Path): List<Path>
    /** 运行 `node --version` 的输出；运行失败返回 null */
    fun nodeVersionOutput(node: Path): String?
}

/**
 * 查找时用到的环境。[env] 来自 `EnvironmentUtil.getEnvironmentMap()`：从 Dock 启动的 IDE 进程 PATH 里没有
 * Homebrew / nvm 的路径，登录 shell 的环境里才有。
 */
data class LookupContext(
    val nodeSetting: String?,
    val codeinsightSetting: String?,
    val env: Map<String, String>,
    val home: Path,
    val windows: Boolean,
)

/**
 * Node 和 codeinsight 的查找顺序：
 * - Node：设置里的路径 → 环境里的 PATH → 常见安装目录；版本低于 [NodeVersion.MINIMUM] 的跳过。
 * - codeinsight：设置里的路径 → 所选 Node 所在目录（nvm 等全局安装的位置）→ PATH → 常见安装目录。
 */
class RuntimeLocator(private val probe: RuntimeProbe) {

    fun findNode(ctx: LookupContext): Lookup {
        val rejected = mutableListOf<Rejected>()
        for (c in nodeCandidates(ctx)) {
            if (!probe.isExecutableFile(c.path)) {
                if (c.origin == Origin.SETTINGS) rejected += Rejected(c.path, "file not found or not executable")
                continue
            }
            val version = NodeVersion.parse(probe.nodeVersionOutput(c.path))
            when {
                version == null -> rejected += Rejected(c.path, "`node --version` failed")
                version < NodeVersion.MINIMUM -> rejected += Rejected(c.path, "version $version < ${NodeVersion.MINIMUM}")
                else -> return Lookup.Found(c.path, c.origin, version)
            }
        }
        return Lookup.NotFound(rejected)
    }

    fun findCodeInsight(ctx: LookupContext, nodePath: Path?): Lookup {
        val rejected = mutableListOf<Rejected>()
        for (c in codeinsightCandidates(ctx, nodePath)) {
            if (probe.isExecutableFile(c.path)) return Lookup.Found(c.path, c.origin)
            if (c.origin == Origin.SETTINGS) rejected += Rejected(c.path, "file not found or not executable")
        }
        return Lookup.NotFound(rejected)
    }

    fun nodeCandidates(ctx: LookupContext): List<Candidate> {
        val names = if (ctx.windows) listOf("node.exe") else listOf("node")
        return ordered(ctx, ctx.nodeSetting, emptyList(), names)
    }

    fun codeinsightCandidates(ctx: LookupContext, nodePath: Path?): List<Candidate> {
        val names = if (ctx.windows) listOf("codeinsight.cmd", "codeinsight.exe") else listOf("codeinsight")
        return ordered(ctx, ctx.codeinsightSetting, listOfNotNull(nodePath?.parent), names)
    }

    private fun ordered(ctx: LookupContext, setting: String?, nodeDirs: List<Path>, names: List<String>): List<Candidate> {
        val out = LinkedHashMap<Path, Candidate>()
        fun add(path: Path, origin: Origin) {
            out.putIfAbsent(path.normalize(), Candidate(path.normalize(), origin))
        }
        setting?.trim()?.takeIf { it.isNotEmpty() }?.let { s -> settingPath(s, ctx.home)?.let { add(it, Origin.SETTINGS) } }
        for (dir in nodeDirs) names.forEach { add(dir.resolve(it), Origin.NODE_DIR) }
        for (dir in pathDirs(ctx)) names.forEach { add(dir.resolve(it), Origin.PATH) }
        for (dir in commonDirs(ctx)) names.forEach { add(dir.resolve(it), Origin.COMMON_DIR) }
        return out.values.toList()
    }

    private fun pathDirs(ctx: LookupContext): List<Path> {
        val raw = ctx.env["PATH"] ?: ctx.env["Path"] ?: return emptyList()
        val sep = if (ctx.windows) ';' else ':'
        return raw.split(sep).filter { it.isNotBlank() }.mapNotNull { toPath(it) }.filter { it.isAbsolute }
    }

    /** 常见安装目录；版本管理器的目录里按版本号从新到旧排 */
    fun commonDirs(ctx: LookupContext): List<Path> {
        if (ctx.windows) {
            return listOfNotNull(
                ctx.env["ProgramFiles"]?.let { toPath(it)?.resolve("nodejs") },
                ctx.env["APPDATA"]?.let { toPath(it)?.resolve("npm") },
            )
        }
        val home = ctx.home
        val nvmDir = ctx.env["NVM_DIR"]?.let { toPath(it) } ?: home.resolve(".nvm")
        return listOf(Path.of("/opt/homebrew/bin"), Path.of("/usr/local/bin")) +
            versionDirs(nvmDir.resolve("versions/node")) +
            listOf(
                home.resolve(".volta/bin"),
                home.resolve(".local/share/fnm/aliases/default/bin"),
                home.resolve("Library/Application Support/fnm/aliases/default/bin"),
                home.resolve(".asdf/shims"),
                home.resolve(".local/share/mise/shims"),
                Path.of("/usr/bin"),
            )
    }

    private fun versionDirs(root: Path): List<Path> =
        probe.subdirectories(root)
            .mapNotNull { dir -> NodeVersion.parse(dir.fileName?.toString())?.let { it to dir } }
            .sortedByDescending { it.first }
            .map { it.second.resolve("bin") }

    /** 设置里允许写 `~/...` */
    private fun settingPath(s: String, home: Path): Path? =
        if (s == "~" || s.startsWith("~/")) home.resolve(s.removePrefix("~").removePrefix("/")) else toPath(s)

    private fun toPath(s: String): Path? = try {
        Path.of(s)
    } catch (_: InvalidPathException) {
        null
    }
}
