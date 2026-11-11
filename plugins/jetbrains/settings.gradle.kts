import org.jetbrains.intellij.platform.gradle.extensions.intellijPlatform

rootProject.name = "codeinsight-jetbrains"

plugins {
    id("org.jetbrains.intellij.platform.settings") version "2.20.1"
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        mavenCentral()
        intellijPlatform {
            defaultRepositories()
        }
    }
}
