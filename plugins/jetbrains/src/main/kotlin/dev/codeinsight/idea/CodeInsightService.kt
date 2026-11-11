package dev.codeinsight.idea

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.util.Disposer
import com.intellij.util.concurrency.AppExecutorUtil
import dev.codeinsight.idea.ide.DataDirExclusion
import dev.codeinsight.idea.runtime.MissingRuntime
import dev.codeinsight.idea.runtime.Resolution
import dev.codeinsight.idea.runtime.resolveServeCommand
import dev.codeinsight.idea.serve.ServeInfo
import dev.codeinsight.idea.serve.ServeLaunchException
import dev.codeinsight.idea.serve.ServeProcess
import dev.codeinsight.idea.settings.CodeInsightProjectSettings
import java.nio.file.Files
import java.nio.file.Path

private val LOG = logger<CodeInsightService>()

/** serve 进程的状态，工具窗口按它切换显示内容 */
sealed interface ServeState {
    data object Idle : ServeState
    data object Starting : ServeState
    data class Running(val info: ServeInfo) : ServeState
    data class Missing(val what: MissingRuntime) : ServeState
    data class Failed(val message: String, val stderrTail: List<String>) : ServeState
    data object NoProject : ServeState
}

/**
 * 每个项目一个 serve 进程：打开工具窗口时启动，项目关闭（服务被释放）时结束。
 * 状态变化在 EDT 上通知监听者。
 */
@Service(Service.Level.PROJECT)
class CodeInsightService(private val project: Project) : Disposable {
    @Volatile
    var state: ServeState = ServeState.Idle
        private set
    private var process: ServeProcess? = null
    private var generation = 0
    private val listeners = mutableListOf<(ServeState) -> Unit>()

    /** 仓库根目录：项目目录或它上层第一个含 `.git` 的目录 */
    val repoRoot: Path? by lazy { project.guessProjectDir()?.toNioPathOrNull()?.let(::findGitRoot) }

    fun addListener(parent: Disposable, listener: (ServeState) -> Unit) {
        synchronized(listeners) { listeners += listener }
        Disposer.register(parent) { synchronized(listeners) { listeners -= listener } }
    }

    /** 还没启动或上次失败时启动 */
    fun start() {
        val gen = synchronized(this) {
            if (state is ServeState.Starting || state is ServeState.Running) return
            generation += 1
            generation
        }
        val repo = repoRoot ?: return publish(gen, ServeState.NoProject)
        publish(gen, ServeState.Starting)
        AppExecutorUtil.getAppExecutorService().execute { launch(gen, repo) }
    }

    /** 设置修改后用新设置重启；结束旧进程可能要等几秒，放到后台线程 */
    fun restartIfStarted() {
        if (state == ServeState.Idle) return
        AppExecutorUtil.getAppExecutorService().execute {
            stopProcess()
            synchronized(this) { state = ServeState.Idle }
            start()
        }
    }

    private fun launch(gen: Int, repo: Path) {
        val dataDir = CodeInsightProjectSettings.getInstance(project).state.dataDir.takeIf { it.isNotBlank() }
        val next = try {
            when (val r = resolveServeCommand(repo, dataDir)) {
                is Resolution.Missing -> ServeState.Missing(r.what)
                is Resolution.Ready -> startProcess(gen, r)
            }
        } catch (e: ServeLaunchException) {
            LOG.warn("serve failed to start: ${e.message}")
            ServeState.Failed(e.message ?: "serve failed to start", e.stderrTail)
        } catch (e: Exception) {
            LOG.warn("serve failed to start", e)
            ServeState.Failed(e.message ?: e.javaClass.simpleName, emptyList())
        }
        publish(gen, next)
        if (next is ServeState.Running) DataDirExclusion.checkOnce(project, repo, dataDir)
    }

    private fun startProcess(gen: Int, ready: Resolution.Ready): ServeState {
        val p = ServeProcess.start(ready.command)
        synchronized(this) {
            if (gen != generation || project.isDisposed) {
                p.stop()
                return state
            }
            process = p
        }
        p.onExit { code -> onProcessExit(gen, p, code) }
        return ServeState.Running(p.info)
    }

    private fun onProcessExit(gen: Int, p: ServeProcess, code: Int) {
        LOG.info("serve exited: pid=${p.pid} exitCode=$code")
        val unexpected = synchronized(this) { process === p && gen == generation }
        if (unexpected) {
            synchronized(this) { process = null }
            publish(gen, ServeState.Failed("codeinsight serve 已退出（退出码 $code）", p.stderrTail()))
        }
    }

    private fun publish(gen: Int, next: ServeState) {
        synchronized(this) {
            if (gen != generation) return
            state = next
        }
        ApplicationManager.getApplication().invokeLater({
            val snapshot = synchronized(listeners) { listeners.toList() }
            snapshot.forEach { it(next) }
        }, project.disposed)
    }

    private fun stopProcess() {
        val p = synchronized(this) {
            generation += 1
            process.also { process = null }
        }
        p?.stop()
    }

    override fun dispose() {
        stopProcess()
    }

    companion object {
        fun getInstance(project: Project): CodeInsightService = project.service()

        fun findGitRoot(start: Path): Path {
            var dir: Path? = start
            while (dir != null) {
                if (Files.exists(dir.resolve(".git"))) return dir
                dir = dir.parent
            }
            return start
        }
    }
}

private fun com.intellij.openapi.vfs.VirtualFile.toNioPathOrNull(): Path? = try {
    toNioPath()
} catch (_: UnsupportedOperationException) {
    null
}
