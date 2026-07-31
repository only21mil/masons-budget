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

android {
    namespace = "com.sats21m.vogelvault"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sats21m.vogelvault"
        // 29 covers GrapheneOS-era devices comfortably while keeping modern APIs.
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // No variant receives a read credential at build time. Users configure
        // it manually and Android keeps it in encrypted app storage.
        buildConfigField("String", "CONVEX_READ_TOKEN", "\"\"")
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
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    implementation("androidx.biometric:biometric:1.1.0")
    // Biometric 1.1.0 otherwise resolves Fragment 1.2.5. Activity 1.2.0+ requires
    // Fragment 1.3.0+ so ActivityResultRegistry permission codes are not rejected.
    implementation("androidx.fragment:fragment:1.8.9")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")

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
    androidTestImplementation(composeBom)

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
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
