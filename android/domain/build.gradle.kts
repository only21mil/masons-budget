plugins {
    kotlin("jvm")
}

kotlin {
    // 17, not 21: the Android app module compiles against Java 17, and a
    // consumer cannot load classes built for a newer JVM. Mismatching these
    // throws UnsupportedClassVersionError at test runtime, not at build time.
    jvmToolchain(17)
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

// These files live outside the Android Gradle root, so Gradle cannot infer them
// from the test sources. Keep the list exact: each entry is a contract consumed
// by a domain parity test. finance-market-cases.json is included before PR #248
// lands so adding that fixture invalidates any previously cached test result.
val sharedDomainFixtureNames =
    listOf(
        "btc-fiat-availability-cases.json",
        "finance-market-cases.json",
        "month-cases.json",
        "todo-cases.json",
        "visibility-cases.json",
    )
val repositoryRoot = rootProject.layout.projectDirectory.dir("..")
val sharedDomainFixtures =
    objects.fileCollection().from(
        sharedDomainFixtureNames.map { name ->
            repositoryRoot.file("shared/domain/fixtures/$name")
        },
    )

val verifySharedFixtureTestInputs =
    tasks.register("verifySharedFixtureTestInputs") {
        group = "verification"
        description = "Verifies that every shared domain parity fixture invalidates :domain:test."

        doLast {
            val expected = sharedDomainFixtures.files.mapTo(linkedSetOf()) { it.canonicalFile }
            val registered = tasks.test.get().inputs.files.files.mapTo(linkedSetOf()) { it.canonicalFile }
            val missing = expected - registered
            check(missing.isEmpty()) {
                val relative = missing.map { it.relativeTo(repositoryRoot.asFile).invariantSeparatorsPath }
                "Shared domain fixtures missing from :domain:test inputs: ${relative.sorted()}"
            }
        }
    }

tasks.test {
    dependsOn(verifySharedFixtureTestInputs)
    inputs.files(sharedDomainFixtures)
        .withPropertyName("sharedDomainParityFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)

    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
    }
}
