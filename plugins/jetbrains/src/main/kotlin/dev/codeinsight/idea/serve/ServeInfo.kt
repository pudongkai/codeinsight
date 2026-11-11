package dev.codeinsight.idea.serve

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class ServeOutputException(message: String) : Exception(message)

/**
 * `codeinsight serve` 启动后在 stdout 输出的那一行 JSON：`{"port":..,"token":"..","url":".."}`。
 * toString 不含 token，避免被打进日志。
 */
class ServeInfo(val port: Int, private val token: String) {
    /** 不带 token 的页面地址，用于日志和界面显示 */
    val baseUrl: String get() = "http://127.0.0.1:$port/"

    /** 首次打开用的地址：serve 校验 token 后设置 cookie 并重定向到 [baseUrl] */
    val loginUrl: String get() = "${baseUrl}?token=${URLEncoder.encode(token, StandardCharsets.UTF_8)}"

    override fun toString(): String = "ServeInfo(port=$port)"

    companion object {
        /** 解析 serve 的第一行 stdout；格式不对时抛出 [ServeOutputException]，异常信息不含原文（原文里有 token） */
        fun parse(line: String?): ServeInfo {
            if (line.isNullOrBlank()) throw ServeOutputException("serve exited before printing its address")
            val obj = parseObject(line.trim())
            val port = intField(obj, "port")
            if (port !in 1..65535) throw ServeOutputException("serve printed an invalid port")
            val token = stringField(obj, "token")
            stringField(obj, "url")
            return ServeInfo(port, token)
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
