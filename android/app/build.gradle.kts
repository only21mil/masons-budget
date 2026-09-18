import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.serialization")
    id("com.google.devtools.ksp")
    id("org.jetbrains.kotlin.plugin.compose")
    id("io.github.takahirom.roborazzi")
}

// A stable debug signing identity, handed in by CI from a repository secret.
//
// Without one, every runner signs with the throwaway ~/.android/debug.keystore
// it generated moments earlier, so each CI build carries a different signing
// certificate and installing one over the last on the Fold dies with
// INSTALL_FAILED_UPDATE_INCOMPATIBLE — you have to uninstall first and lose the
// app's state every single time.
//
// Every value comes from the environment. No key material, path, or password is
// committed. When the variables are absent — forks, secretless runs, and all
// local development — the debug signing config is left exactly as AGP set it up
// and Gradle's generated keystore is used as before, so the build still works.
val ciDebugKeystore = providers.environmentVariable("VOGEL_DEBUG_KEYSTORE").orNull
    ?.takeIf { it.isNotBlank() }
    ?.let { file(it) }
    ?.takeIf { it.isFile }

// The Android debug defaults are published constants rather than secrets, and
// they are what `keytool -genkey` produces when you follow the standard recipe.
// Defaulting to them means the keystore secret alone is enough; the three
// password/alias secrets only exist for a keystore that deviates.
val ciDebugStorePassword = providers.environmentVariable("VOGEL_DEBUG_KEYSTORE_PASSWORD")
    .orNull?.takeIf { it.isNotBlank() } ?: "android"
val ciDebugKeyAlias = providers.environmentVariable("VOGEL_DEBUG_KEY_ALIAS")
    .orNull?.takeIf { it.isNotBlank() } ?: "androiddebugkey"
val ciDebugKeyPassword = providers.environmentVariable("VOGEL_DEBUG_KEY_PASSWORD")
    .orNull?.takeIf { it.isNotBlank() } ?: "android"

/**
 * One guarded bootstrap build may carry a short-lived read + todo-write pairing.
 * Normal builds still receive the empty default below. The value comes only from
 * an owned mode-0600 file under $HOME/work; no command-line property, Gradle cache,
 * release variant, or read-token environment variable can supply it. CI remains
 * forbidden except for the exact manual GitHub Actions purpose below.
 *
 * The environment file alone is not enough. A pairing is accepted only when
 * `vogel.vault.android.readBootstrapOptIn=true` is ALSO set in android/local.properties
 * (a git-ignored file), so a stray or leaked environment variable can never
 * silently re-arm a claimable credential into an ordinary build.
 */
fun localAndroidReadBootstrapOptIn(): Boolean {
    val localProperties = Properties()
    val file = rootProject.file("local.properties")
    if (file.isFile) {
        file.inputStream().use { stream -> localProperties.load(stream) }
    }
    return localProperties.getProperty("vogel.vault.android.readBootstrapOptIn") == "true"
}

fun localAndroidReadBootstrap(): String? {
    val rawPath = providers.environmentVariable("VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE")
        .orNull
        ?.takeIf { it.isNotBlank() }
        ?: return null
    val ci = providers.environmentVariable("CI").orNull
    if (!ci.isNullOrBlank()) {
        val approved =
            ci == "true" &&
                providers.environmentVariable("GITHUB_ACTIONS").orNull == "true" &&
                providers.environmentVariable("GITHUB_EVENT_NAME").orNull == "workflow_dispatch" &&
                providers.environmentVariable("VOGEL_VAULT_ANDROID_BOOTSTRAP_CI_PURPOSE").orNull ==
                "android-read-bootstrap-apk-v1"
        check(approved) {
            "Android read-bootstrap builds are forbidden in CI outside the approved GitHub Actions workflow_dispatch path."
        }
    }
    check(localAndroidReadBootstrapOptIn()) {
        "VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE is set, but local.properties does not carry " +
            "vogel.vault.android.readBootstrapOptIn=true. Set that opt-in explicitly before " +
            "building a credential-bearing APK."
    }
    check(gradle.startParameter.taskNames == listOf(":app:assembleDebug")) {
        "A bootstrap input is accepted only for the exact :app:assembleDebug task."
    }
    check(!gradle.startParameter.isBuildCacheEnabled) {
        "Android read-bootstrap builds require --no-build-cache."
    }
    check(!gradle.startParameter.isConfigurationCacheRequested) {
        "Android read-bootstrap builds require --no-configuration-cache."
    }
    check(ciDebugKeystore != null) {
        "Android read-bootstrap builds require the stable debug signing keystore."
    }

    val home = providers.environmentVariable("HOME").orNull
        ?.takeIf { it.isNotBlank() }
        ?.let(Path::of)
        ?: error("HOME is required for an Android read-bootstrap build.")
    check(home.isAbsolute) { "HOME must be an absolute path." }
    val workRoot = home.resolve("work").toRealPath()
    val requested = Path.of(rawPath)
    check(requested.isAbsolute) {
        "VOGEL_VAULT_ANDROID_BOOTSTRAP_FILE must be an absolute path."
    }
    check(!Files.isSymbolicLink(requested) && Files.isRegularFile(requested, NOFOLLOW_LINKS)) {
        "Android read-bootstrap input must be a regular file, not a symlink."
    }
    val resolved = requested.toRealPath()
    check(resolved.startsWith(workRoot) && resolved != workRoot) {
        "Android read-bootstrap input must resolve beneath HOME/work."
    }
    check(Files.getOwner(requested, NOFOLLOW_LINKS) == Files.getOwner(home, NOFOLLOW_LINKS)) {
        "Android read-bootstrap input must be owned by the current user."
    }
    check(
        Files.getPosixFilePermissions(requested, NOFOLLOW_LINKS) ==
            PosixFilePermissions.fromString("rw-------"),
    ) {
        "Android read-bootstrap input must have exact mode 0600."
    }
    val bytes = Files.readAllBytes(resolved)
    check(bytes.isNotEmpty() && bytes.size <= 160 && bytes.all { it >= 0 }) {
        "Android read-bootstrap input must contain 1-160 ASCII bytes."
    }
    val pairing = String(bytes, StandardCharsets.US_ASCII)
    check(Regex("^android-read-[A-Za-z0-9_-]{16,64}\\.[A-Za-z0-9_-]{43}$").matches(pairing)) {
        "Android read-bootstrap input does not match the required pairing format."
    }
    val proof = pairing.substringAfterLast('.')
    val decoded = runCatching { Base64.getUrlDecoder().decode(proof) }.getOrNull()
    check(
        decoded?.size == 32 &&
            Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == proof,
    ) {
        "Android read-bootstrap proof must canonically encode exactly 32 bytes."
    }
    return pairing
}

val localAndroidReadBootstrap = localAndroidReadBootstrap()

android {
    namespace = "com.sats21m.vogelvault"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sats21m.vogelvault"
        // 29 covers GrapheneOS-era devices comfortably while keeping modern APIs.
        minSdk = 29
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.1"
        // No variant receives a read credential at build time. Users configure
        // it manually and Android keeps it in encrypted app storage.
        buildConfigField("String", "CONVEX_READ_TOKEN", "\"\"")
        // A normal build also contains no bootstrap capability. Only the exact
        // guarded local debug invocation above can override this field.
        buildConfigField("String", "CONVEX_READ_BOOTSTRAP_PAIR", "\"\"")
        // Non-secret build intent. Only the guarded combined bootstrap variant
        // requests a client-generated todo-write device credential.
        buildConfigField("boolean", "CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE", "false")
    }

    signingConfigs {
        // AGP already wires this config into the debug build type; overriding it
        // in place keeps the fallback a genuine no-op rather than a second path.
        getByName("debug") {
            if (ciDebugKeystore != null) {
                storeFile = ciDebugKeystore
                storePassword = ciDebugStorePassword
                keyAlias = ciDebugKeyAlias
                keyPassword = ciDebugKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            // Release signing is not configured here on purpose — distribution
            // is an approval-gated step, not a build flag.
            isMinifyEnabled = false
            if (localAndroidReadBootstrap != null) {
                // The wire alphabet excludes quotes and backslashes, so this is
                // already safe as a generated Java string literal.
                buildConfigField(
                    "String",
                    "CONVEX_READ_BOOTSTRAP_PAIR",
                    "\"$localAndroidReadBootstrap\"",
                )
                buildConfigField(
                    "boolean",
                    "CONVEX_READ_BOOTSTRAP_REQUEST_TODO_WRITE",
                    "true",
                )
            }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Structural backstop for the audit's L3: the pairing is only ever
            // injected into the debug build type above, and a release build must
            // refuse to configure at all if any future change regresses that.
            check(localAndroidReadBootstrap == null) {
                "A release build must never embed the read-bootstrap pairing."
            }
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        jvmToolchain(17)
    }

    lint {
        warningsAsErrors = false
        abortOnError = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }

    testOptions {
        unitTests {
            // Robolectric needs real resources to render Compose.
            isIncludeAndroidResources = true
        }
    }
}

// Schemas are checked in so every future migration has a deterministic source
// schema. KSP writes here in CI; no destructive fallback is configured below.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.generateKotlin", "true")
}

dependencies {
    // The shared contract. Plain JVM — no Android types cross this boundary.
    implementation(project(":domain"))

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    // 1.1.0 (June 2020) predates the API 30 device-credential prompt regressions.
    // The 1.2.x line carries those fixes; no stable 1.2.x release exists yet
    // (1.2.0-alpha05 is the newest of the line), which the audit accepted.
    implementation("androidx.biometric:biometric:1.2.0-alpha05")
    // Biometric 1.1.0 otherwise resolves Fragment 1.2.5. Activity 1.2.0+ requires
    // Fragment 1.3.0+ so ActivityResultRegistry permission codes are not rejected.
    implementation("androidx.fragment:fragment:1.8.9")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    val roomVersion = "2.7.2"
    implementation("androidx.room:room-runtime:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")

    // B3's strict Convex row decoder uses JsonElement so tagged int64 values can
    // be decoded lexically without ever passing money through Double.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")

    // Compose UI Test 1.7.6's Robolectric idle check does not flush process-global
    // Snapshot apply notifications, so a screen that recomposes can strand them past
    // its own Activity and hang the next Compose test in the same JVM for the full
    // 60s Espresso timeout. 1.8.2 sends them before checking idleness.
    val composeBom = platform("androidx.compose:compose-bom:2025.05.01")
    implementation(composeBom)

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.window:window:1.2.0")
    implementation("androidx.compose.material:material-icons-extended")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("androidx.room:room-testing:$roomVersion")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.36.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.36.0")
}

// These files live outside the Android Gradle root, so Gradle cannot infer them
// from the app test sources. The app's wire and finance tests read them directly;
// a cached test result must never make a changed shared contract look green.
val repositoryRoot = rootProject.layout.projectDirectory.dir("..")
val sharedAppTestFixtures =
    objects.fileCollection().from(
        repositoryRoot.file("shared/domain/fixtures/finance-market-cases.json"),
        repositoryRoot.file("shared/domain/fixtures/payment-source-cases.json"),
        repositoryRoot.dir("shared/domain/fixtures/convex-wire-golden"),
    )

val verifySharedAppTestInputs =
    tasks.register("verifySharedAppTestInputs") {
        group = "verification"
        description = "Verifies that shared fixtures invalidate :app:testDebugUnitTest."
        dependsOn(project(":domain").tasks.named("jar"))

        doLast {
            val expected = sharedAppTestFixtures.files.mapTo(linkedSetOf()) { it.canonicalFile }
            val registered =
                tasks.named<Test>("testDebugUnitTest").get().inputs.files.files
                    .mapTo(linkedSetOf()) { it.canonicalFile }
            val missing = expected - registered
            check(missing.isEmpty()) {
                val relative = missing.map { it.relativeTo(repositoryRoot.asFile).invariantSeparatorsPath }
                "Shared app test fixtures missing from :app:testDebugUnitTest inputs: ${relative.sorted()}"
            }
        }
    }

tasks.withType<Test>().configureEach {
    if (name == "testDebugUnitTest") dependsOn(verifySharedAppTestInputs)
}

// CI keeps the behavioural app suite in the required PR check while moving the
// screenshot-producing design packet to a separate default-branch step. The
// ordinary local task remains unchanged and includes every test.
//
// Robolectric normally downloads its 150–200 MB android-all runtime from Maven
// inside the test JVM. CI prefetches and checksum-verifies those runtimes, then
// points Robolectric at the warmed directory in offline mode so a Maven outage
// cannot turn into a test failure after Gradle has already started the suite.
val designPacketTests = "com.sats21m.vogelvault.DesignPacket*Test"
val designPacketTestMode = providers.gradleProperty("designPacketTests").orElse("include")
val robolectricOffline = providers.gradleProperty("robolectricOffline").orElse("false")
val robolectricDependencyDir = providers.gradleProperty("robolectricDependencyDir")

tasks.withType<Test>().configureEach {
    if (name != "testDebugUnitTest") return@configureEach

    inputs.files(sharedAppTestFixtures)
        .withPropertyName("sharedAppTestFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)

    filter {
        when (designPacketTestMode.get()) {
            "include" -> Unit
            "exclude" -> excludeTestsMatching(designPacketTests)
            "only" -> includeTestsMatching(designPacketTests)
            else ->
                throw GradleException(
                    "designPacketTests must be one of: include, exclude, only",
                )
        }
    }

    when (robolectricOffline.get()) {
        "false" -> Unit
        "true" -> {
            val dependencyDir =
                robolectricDependencyDir.orNull?.takeIf { it.isNotBlank() }
                    ?: throw GradleException(
                        "robolectricDependencyDir is required when robolectricOffline=true",
                    )
            systemProperty("robolectric.offline", "true")
            systemProperty("robolectric.dependency.dir", dependencyDir)
        }
        else -> throw GradleException("robolectricOffline must be true or false")
    }
}
