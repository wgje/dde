plugins {
  id("com.android.test")
  kotlin("android")
}

fun quoted(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

fun propertyOrEnv(name: String, envName: String, defaultValue: String): String {
  return providers.gradleProperty(name).orNull
    ?: providers.environmentVariable(envName).orNull
    ?: defaultValue
}

val targetPackage = propertyOrEnv(
  name = "nanoflow.android.applicationId",
  envName = "ANDROID_TWA_PACKAGE_NAME",
  defaultValue = "app.nanoflow.twa",
)
val expectedSerial = providers.environmentVariable("ANDROID_SERIAL").orNull.orEmpty()
val expectedProjectLabel = providers.environmentVariable("NANOFLOW_DEVICE_TEST_PROJECT_LABEL")
  .orNull
  .orEmpty()

android {
  namespace = "app.nanoflow.host.acceptance"
  compileSdk = 35

  defaultConfig {
    minSdk = 28
    targetSdk = 35
    manifestPlaceholders["nanoflowTargetPackage"] = targetPackage
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    testInstrumentationRunnerArguments["nanoflowTargetPackage"] = targetPackage
    testInstrumentationRunnerArguments["nanoflowExpectedSerial"] = expectedSerial
    testInstrumentationRunnerArguments["nanoflowExpectedProjectLabel"] = expectedProjectLabel
    buildConfigField("String", "NANOFLOW_TARGET_PACKAGE", quoted(targetPackage))
  }

  targetProjectPath = ":app"
  experimentalProperties["android.experimental.self-instrumenting"] = true

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }

  buildFeatures {
    buildConfig = true
  }
}

dependencies {
  implementation("androidx.test:runner:1.6.2")
  implementation("androidx.test.ext:junit:1.2.1")
  implementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
