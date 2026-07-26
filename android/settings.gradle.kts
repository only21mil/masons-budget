// The Vogel Vault — Android client.
//
// The `domain` module is a plain Kotlin/JVM library on purpose: it holds the
// family/visibility contract and money maths, needs no Android SDK, and can be
// tested on any runner with just a JDK. The Android app module lands on top of
// it once this is green.

pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "vogel-vault-android"

include(":domain")
