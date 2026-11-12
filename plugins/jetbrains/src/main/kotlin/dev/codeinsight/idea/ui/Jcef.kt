package dev.codeinsight.idea.ui

import com.intellij.ui.jcef.JBCefApp

/**
 * JCEF 是否可用。2026.2 起 JCEF 是单独的插件，插件包和 IDE 版本对不上或 JCEF 插件被禁用时
 * 类会加载失败，此时按不可用处理，退回"在浏览器中打开"。
 */
internal fun jcefSupported(): Boolean = try {
    JBCefApp.isSupported()
} catch (e: LinkageError) {
    false
}
