package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowTwaLauncherActivityContractTest {
  private val source: String by lazy {
    val candidates = listOf(
      Path.of("src/main/java/app/nanoflow/host/NanoflowTwaLauncherActivity.kt"),
      Path.of("app/src/main/java/app/nanoflow/host/NanoflowTwaLauncherActivity.kt"),
      Path.of("android/app/src/main/java/app/nanoflow/host/NanoflowTwaLauncherActivity.kt"),
    )
    val sourcePath = candidates.firstOrNull(Files::exists)
      ?: error("NanoflowTwaLauncherActivity.kt was not found from ${Path.of("").toAbsolutePath()}")
    sourcePath.toFile().readText()
  }

  @Test
  fun `launcher path never blocks while resolving a widget URL`() {
    assertFalse(source.contains("import kotlinx.coroutines.runBlocking"))
    assertFalse(Regex("""\brunBlocking\s*\{""").containsMatchIn(source))
  }

  @Test
  fun `getLaunchingUrl only returns the winning cached URL`() {
    val body = functionBody("override fun getLaunchingUrl")

    assertTrue(body.contains("cachedLaunchUri"))
    listOf(
      "NanoflowWidgetRepository",
      "buildLaunchUri",
      "resolveLaunchingUrl",
      "runBlocking",
    ).forEach { forbidden ->
      assertFalse(body.contains(forbidden), "getLaunchingUrl must not contain $forbidden")
    }
  }

  @Test
  fun `manual ABH launch caches the winning URL before launchTwa`() {
    assertTrue(source.contains("override fun shouldLaunchImmediately(): Boolean = false"))
    assertTrue(source.contains("lifecycleScope"))
    assertTrue(source.contains("LifecycleOwner"))

    val body = functionBody("private fun commitPreparedLaunch")
    val cacheIndex = body.indexOf("cachedLaunchUri =")
    val telemetryIndex = body.indexOf("logLaunchStarted(")
    val launchIndex = body.indexOf("launchTwa()")

    assertTrue(cacheIndex >= 0, "winning URL must be cached")
    assertTrue(telemetryIndex > cacheIndex, "winning URL must be cached before telemetry")
    assertTrue(launchIndex > telemetryIndex, "telemetry must describe the URL passed to launchTwa")
  }

  @Test
  fun `ordinary icon launch stays synchronous`() {
    val dispatchBody = functionBody("private fun launchFromCurrentIntent")
    assertTrue(dispatchBody.contains("AppWidgetManager.INVALID_APPWIDGET_ID"))
    assertTrue(dispatchBody.contains("launchImmediately(request)"))

    val immediateBody = functionBody("private fun launchImmediately")
    assertTrue(immediateBody.contains("NanoflowBootstrapContract.buildLaunchUri"))
    assertTrue(immediateBody.contains("commitPreparedLaunch"))
    assertFalse(immediateBody.contains("launchCoordinator"))
    assertFalse(immediateBody.contains("lifecycleScope"))
  }

  @Test
  fun `onNewIntent retires the previous generation before relaunching`() {
    val body = functionBody("override fun onNewIntent")
    val retireIndex = body.indexOf("retireGeneration()")
    val launchIndex = body.indexOf("launchFromCurrentIntent()")

    assertTrue(retireIndex >= 0, "onNewIntent must retire the previous generation")
    assertTrue(launchIndex > retireIndex, "the previous generation must retire before relaunch")
  }

  private fun functionBody(signature: String): String {
    val signatureIndex = source.indexOf(signature)
    check(signatureIndex >= 0) { "Missing function signature: $signature" }
    val openBrace = source.indexOf('{', signatureIndex)
    check(openBrace >= 0) { "Missing function body: $signature" }

    var depth = 0
    var index = openBrace
    var state = ScanState.CODE
    while (index < source.length) {
      val current = source[index]
      val next = source.getOrNull(index + 1)
      when (state) {
        ScanState.CODE -> when {
          current == '/' && next == '/' -> {
            state = ScanState.LINE_COMMENT
            index += 1
          }
          current == '/' && next == '*' -> {
            state = ScanState.BLOCK_COMMENT
            index += 1
          }
          current == '"' -> state = ScanState.STRING
          current == '\'' -> state = ScanState.CHAR
          current == '{' -> depth += 1
          current == '}' -> {
            depth -= 1
            if (depth == 0) {
              return source.substring(openBrace + 1, index)
            }
          }
        }
        ScanState.LINE_COMMENT -> if (current == '\n') state = ScanState.CODE
        ScanState.BLOCK_COMMENT -> if (current == '*' && next == '/') {
          state = ScanState.CODE
          index += 1
        }
        ScanState.STRING -> when {
          current == '\\' -> index += 1
          current == '"' -> state = ScanState.CODE
        }
        ScanState.CHAR -> when {
          current == '\\' -> index += 1
          current == '\'' -> state = ScanState.CODE
        }
      }
      index += 1
    }

    error("Unterminated function body: $signature")
  }

  private enum class ScanState {
    CODE,
    LINE_COMMENT,
    BLOCK_COMMENT,
    STRING,
    CHAR,
  }
}
