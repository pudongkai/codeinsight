import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.kotlin.gradle.dsl.JvmDefaultMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform")
}

group = "dev.codeinsight"

/**
 * 两个插件包：2026.2 起 JCEF 是单独的插件（com.intellij.modules.jcef），用到它的插件要声明依赖
 * 模块 intellij.platform.ui.jcef；这个模块在更早的版本里不存在，声明了插件就加载不了。
 * 默认打 2026.2+ 的包，`-PideTarget=251` 打 2025.1–2026.1 的包。
 */
data class IdeTarget(val sinceBuild: String, val untilBuild: String?, val suffix: String, val dependencies: String)

val target: IdeTarget = when (providers.gradleProperty("ideTarget").getOrElse("262")) {
    "251" -> IdeTarget(
        "251", "261.*", "-251",
        "<depends>com.intellij.modules.platform</depends>",
    )
    else -> IdeTarget(
        "262", null, "",
        "<dependencies>\n        <plugin id=\"com.intellij.modules.platform\"/>\n" +
            "        <module name=\"intellij.platform.ui.jcef\"/>\n    </dependencies>",
    )
}
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
        // 2025.1 自带的 Kotlin 标准库是 2.1，插件不打包标准库，API 不能用更新的版本
        apiVersion = KotlinVersion.KOTLIN_2_1
        languageVersion = KotlinVersion.KOTLIN_2_1
        // 接口默认方法直接用 JVM default，不在实现类里生成转发方法（否则会被 Plugin Verifier 算作调用平台内部 API）
        jvmDefault = JvmDefaultMode.NO_COMPATIBILITY
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = target.sinceBuild
            untilBuild = provider { target.untilBuild }
        }
    }
    pluginVerification {
        ides {
            recommended()
        }
    }
}

tasks.patchPluginXml {
    val dependencies = target.dependencies
    doLast {
        val file = outputFile.get().asFile
        file.writeText(file.readText().replace(Regex("<!-- @DEPENDENCIES@[^>]*-->"), dependencies))
    }
}

tasks.buildPlugin {
    archiveFileName.set("codeinsight-jetbrains-${project.version}${target.suffix}.zip")
}
