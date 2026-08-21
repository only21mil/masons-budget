// Plugin versions are declared here once, applied per module.
plugins {
    id("com.android.application") version "8.7.3" apply false
    kotlin("android") version "2.1.0" apply false
    kotlin("jvm") version "2.1.0" apply false
    kotlin("plugin.serialization") version "2.1.0" apply false
    id("com.google.devtools.ksp") version "2.1.0-1.0.29" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
    // Renders Compose to PNG under Robolectric, so the design packet needs no
    // emulator and no display — same review model as the Linux client.
    id("io.github.takahirom.roborazzi") version "1.36.0" apply false
}
