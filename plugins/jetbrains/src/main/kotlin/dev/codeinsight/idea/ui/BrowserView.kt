package dev.codeinsight.idea.ui

import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.concurrency.AppExecutorUtil
import dev.codeinsight.idea.ide.ReviewWorking
import dev.codeinsight.idea.ide.SourceNavigator
import dev.codeinsight.idea.serve.ServeInfo
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandler
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandler
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import javax.swing.JComponent

private val LOG = logger<BrowserView>()

/**
 * JCEF 里的 Web UI。主框架加载完 serve 自己的页面时注入 JS 桥 `window.codeinsightHost`（形状见 packages/web/src/bridge.ts）；
 * 内嵌浏览器只停留在 serve 的地址下，其他地址的导航被拦下，用户点击的外部链接交给系统浏览器。
 * 插件请求审查时调用页面的 `window.codeinsightPage.reviewWorking()`；页面还没加载完时先记下，加载完成后再调用。
 */
class BrowserView(private val project: Project, private val info: ServeInfo) : Disposable {
    private val browser = JBCefBrowser()
    private val openFileQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val reviewQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)

    /** [loaded] 和 [pendingReview] 在 EDT 和 CEF 线程上读写，一起加锁，避免审查请求在两者之间丢失 */
    private val pageLock = Any()
    private var loaded = false
    private var pendingReview = false

    val component: JComponent get() = browser.component

    init {
        Disposer.register(this, browser)
        Disposer.register(this, openFileQuery)
        Disposer.register(this, reviewQuery)
        openFileQuery.addHandler { arg -> handleOpenFile(arg); null }
        reviewQuery.addHandler {
            ApplicationManager.getApplication().invokeLater({ ReviewWorking.run(project) }, project.disposed)
            null
        }
        browser.jbCefClient.addLoadHandler(loadHandler(), browser.cefBrowser)
        browser.jbCefClient.addRequestHandler(requestHandler(), browser.cefBrowser)
        browser.loadURL(info.loginUrl)
    }

    fun requestReviewWorking() {
        val runNow = synchronized(pageLock) {
            if (!loaded) pendingReview = true
            loaded
        }
        if (runNow) runJs(TRIGGER_REVIEW_JS)
    }

    private fun isServePage(url: String?): Boolean = url != null && url.startsWith(info.baseUrl)

    private fun loadHandler(): CefLoadHandler = object : CefLoadHandlerAdapter() {
        override fun onLoadStart(b: CefBrowser, frame: CefFrame, transitionType: CefRequest.TransitionType) {
            if (frame.isMain) synchronized(pageLock) { loaded = false }
        }

        override fun onLoadEnd(b: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
            if (!frame.isMain) return
            if (!isServePage(frame.url)) {
                LOG.warn("not injecting the JS bridge into a page outside ${info.baseUrl}")
                return
            }
            runJs(bridgeJs())
            val runPending = synchronized(pageLock) {
                loaded = true
                pendingReview.also { pendingReview = false }
            }
            LOG.info("web UI loaded (HTTP $httpStatusCode), JS bridge injected")
            if (runPending) runJs(TRIGGER_REVIEW_JS)
        }
    }

    /** 只允许 serve 地址下的导航；用户点击的 http(s) 外部链接用系统浏览器打开，其他一律拦下 */
    private fun requestHandler(): CefRequestHandler = object : CefRequestHandlerAdapter() {
        override fun onBeforeBrowse(b: CefBrowser, frame: CefFrame, request: CefRequest, userGesture: Boolean, isRedirect: Boolean): Boolean {
            val url = request.url
            if (isServePage(url) || url == "about:blank") return false
            val external = userGesture && (url.startsWith("https://") || url.startsWith("http://"))
            LOG.warn("blocked navigation away from the web UI (opened externally: $external)")
            if (external) ApplicationManager.getApplication().invokeLater { BrowserUtil.browse(url) }
            return true
        }
    }

    private fun bridgeJs(): String = """
        window.codeinsightHost = {
          openFile: function (path, line) {
            var request = JSON.stringify({ path: String(path), line: Number(line) });
            ${openFileQuery.inject("request")}
          },
          reviewWorking: function () {
            var request = '';
            ${reviewQuery.inject("request")}
          }
        };
    """.trimIndent()

    private fun handleOpenFile(arg: String) {
        try {
            val obj = JsonParser.parseString(arg).asJsonObject
            val path = obj.get("path").asString
            val line = obj.get("line").asDouble.takeIf { it.isFinite() }?.toInt() ?: 1
            LOG.debug("openFile $path:$line")
            AppExecutorUtil.getAppExecutorService().execute { SourceNavigator.open(project, info.repo, path, line) }
        } catch (e: Exception) {
            LOG.warn("invalid openFile request from the web UI", e)
        }
    }

    private fun runJs(code: String) {
        browser.cefBrowser.executeJavaScript(code, info.baseUrl, 0)
    }

    override fun dispose() = Unit

    private companion object {
        /** 页面还没注册 `codeinsightPage` 时只留标记，页面注册时补做（见 bridge.ts 的 registerPage） */
        const val TRIGGER_REVIEW_JS =
            "if (window.codeinsightPage) { window.codeinsightPage.reviewWorking(); } else { window.codeinsightPendingReviewWorking = true; }"
    }
}
