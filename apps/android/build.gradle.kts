buildscript {
    val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath(libs.findLibrary("kotlin-gradle-plugin").get())
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
}
