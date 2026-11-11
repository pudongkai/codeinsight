package dev.codeinsight.idea.serve

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path

class ServeOutputException(message: String) : Exception(message)

/**
 * `codeinsight serve` 启动后在 stdout 输出的那一行 JSON：`{"port":..,"token":"..","url":"..","repo":"..","dataDir":".."}`。
 * [repo] 是 serve 定位到的仓库根目录，[dataDir] 是它实际使用的数据目录（已考虑环境变量和配置文件），
 * 插件直接用这两个值，不自己再算一遍。toString 不含 token，避免被打进日志。
 */
class ServeInfo(val port: Int, private val token: String, val repo: Path, val dataDir: Path) {
    /** 不带 token 的页面地址，用于日志和界面显示 */
    val baseUrl: String get() = "http://127.0.0.1:$port/"

    /** 首次打开用的地址：serve 校验 token 后设置 cookie 并重定向到 [baseUrl] */
    val loginUrl: String get() = "${baseUrl}?token=${URLEncoder.encode(token, StandardCharsets.UTF_8)}"

    /**
     * serve 给出的是解析过符号链接的真实路径（如 macOS 上 /tmp 实为 /private/tmp），IDE 则按打开项目时的路径管理文件。
     * [projectDir] 或它的上层目录就是 [repo] 时，把 [repo] 和仓库内的 [dataDir] 换成这条路径下的写法，排除目录和跳转才能对上项目里的文件。
     */
    fun localizedTo(projectDir: Path): ServeInfo {
        val local = generateSequence(projectDir.toAbsolutePath().normalize()) { it.parent }.firstOrNull { sameFile(it, repo) }
        if (local == null || local == repo) return this
        val data = if (dataDir.startsWith(repo)) local.resolve(repo.relativize(dataDir)) else dataDir
        return ServeInfo(port, token, local, data)
    }

    private fun sameFile(a: Path, b: Path): Boolean = try {
        Files.isSameFile(a, b)
    } catch (_: IOException) {
        false
    }

    override fun toString(): String = "ServeInfo(port=$port, repo=$repo, dataDir=$dataDir)"

    companion object {
        /** 解析 serve 的第一行 stdout；格式不对时抛出 [ServeOutputException]，异常信息不含原文（原文里有 token） */
        fun parse(line: String?): ServeInfo {
            if (line.isNullOrBlank()) throw ServeOutputException("serve exited before printing its address")
            val obj = parseObject(line.trim())
            val port = intField(obj, "port")
            if (port !in 1..65535) throw ServeOutputException("serve printed an invalid port")
            val token = stringField(obj, "token")
            stringField(obj, "url")
            return ServeInfo(port, token, absolutePath(obj, "repo"), absolutePath(obj, "dataDir"))
        }

        /** 旧版 serve 不输出这两个字段，报错时提示升级 */
        private fun absolutePath(obj: JsonObject, name: String): Path {
            if (obj.get(name) == null) throw ServeOutputException("serve output has no \"$name\"; codeinsight may be too old, please upgrade it")
            val path = try {
                Path.of(stringField(obj, name))
            } catch (_: InvalidPathException) {
                null
            }
            return path?.takeIf { it.isAbsolute }?.normalize()
                ?: throw ServeOutputException("serve output field \"$name\" is not an absolute path")
        }

        private fun parseObject(text: String): JsonObject {
            val element = try {
                JsonParser.parseString(text)
            } catch (_: Exception) {
                null
            }
            return element?.takeIf { it.isJsonObject }?.asJsonObject
                ?: throw ServeOutputException("serve output is not a JSON object")
        }

        private fun primitive(obj: JsonObject, name: String): JsonPrimitive {
            val value = obj.get(name)
            if (value == null || !value.isJsonPrimitive) throw ServeOutputException("serve output has no \"$name\"")
            return value.asJsonPrimitive
        }

        private fun intField(obj: JsonObject, name: String): Int {
            val p = primitive(obj, name)
            if (!p.isNumber) throw ServeOutputException("serve output field \"$name\" is not a number")
            val d = p.asDouble
            if (d != Math.floor(d)) throw ServeOutputException("serve output field \"$name\" is not an integer")
            return d.toInt()
        }

        private fun stringField(obj: JsonObject, name: String): String {
            val p = primitive(obj, name)
            if (!p.isString || p.asString.isEmpty()) throw ServeOutputException("serve output field \"$name\" is empty")
            return p.asString
        }
    }
}
