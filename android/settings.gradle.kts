// The Vogel Vault — Android client.
//
// `domain` is a plain Kotlin/JVM library on purpose: it holds the
// family/visibility contract, money maths and read model, needs no Android SDK,
// and can be tested on any runner with just a JDK.
//
// `app` is the Compose application for the Pixel Fold and needs the SDK.

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
include(":app")
