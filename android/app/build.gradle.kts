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
            // Debug-signed only. Release signing is not configured here on
            // purpose — distribution is an approval-gated step, not a build flag.
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
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
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    val roomVersion = "2.7.2"
    implementation("androidx.room:room-runtime:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")

    // B3's strict Convex row decoder uses JsonElement so tagged int64 values can
    // be decoded lexically without ever passing money through Double.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.0")

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
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
