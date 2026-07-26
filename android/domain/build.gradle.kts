plugins {
    kotlin("jvm")
}

kotlin {
    jvmToolchain(21)
}

// No `repositories` block here on purpose: settings.gradle.kts sets
// RepositoriesMode.FAIL_ON_PROJECT_REPOS, so repositories are declared once,
// centrally. Adding them per-module fails the build.

dependencies {
    testImplementation(kotlin("test"))
    // Test-only: reads the shared fixture JSON that the TypeScript suite also
    // consumes. Deliberately not a production dependency — the domain module
    // itself has none.
    testImplementation("com.google.code.gson:gson:2.11.0")
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
    }
}
