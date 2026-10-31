package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetBootstrapActivityContractTest {
  private val source: String by lazy {
    val candidates = listOf(
      Path.of("src/main/java/app/nanoflow/host/NanoflowWidgetBootstrapActivity.kt"),
      Path.of("app/src/main/java/app/nanoflow/host/NanoflowWidgetBootstrapActivity.kt"),
      Path.of("android/app/src/main/java/app/nanoflow/host/NanoflowWidgetBootstrapActivity.kt"),
    )
    val sourcePath = candidates.firstOrNull(Files::exists)
      ?: error("NanoflowWidgetBootstrapActivity.kt was not found from ${Path.of("").toAbsolutePath()}")
    sourcePath.toFile().readText()
  }

  @Test
  fun `bootstrap Activity never blocks or consumes persistence directly`() {
    assertFalse(source.contains("import kotlinx.coroutines.runBlocking"))
    assertFalse(Regex("""\brunBlocking\s*\{""").containsMatchIn(source))
    assertFalse(source.contains("consumeBootstrapUri"))
  }

  @Test
  fun `Activity attaches an owner before submitting its first callback`() {
    val onCreateBody = functionBody("override fun onCreate")
    val attachIndex = onCreateBody.indexOf("NanoflowWidgetBootstrapProcessCoordinator.attach(")
    val dispatchIndex = onCreateBody.indexOf("handleBootstrapIntent(intent)")

    assertTrue(attachIndex >= 0, "onCreate must attach an Activity owner")
    assertTrue(dispatchIndex > attachIndex, "owner attachment must precede initial callback submission")
  }

  @Test
  fun `callback handler only submits immutable callback data`() {
    val body = functionBody("private fun handleBootstrapIntent")

    assertTrue(body.contains("NanoflowWidgetBootstrapProcessCoordinator.submit("))
    assertTrue(body.contains("intent?.data"))
    assertFalse(body.contains("NanoflowWidgetRepository"))
    assertFalse(body.contains("consumeBootstrapUri"))
  }

  @Test
  fun `accepted callback owns no repository network coroutine or timeout work`() {
    val body = functionBody("private fun handleAcceptedBootstrap")

    assertFalse(source.contains("NanoflowWidgetRepository"))
    assertFalse(source.contains("refreshInstalledWidgets"))
    assertFalse(source.contains("refreshAllWidgets"))
    assertFalse(source.contains("kotlinx.coroutines"))
    assertFalse(source.contains("BOOTSTRAP_INLINE_REFRESH_TIMEOUT_MS"))
    assertFalse(source.contains("10_000"))
    assertFalse(source.contains("nanoflow_widget_bootstrap_refresh_delayed_toast"))
    assertTrue(body.contains("completeAcceptedBootstrap("))
  }

  @Test
  fun `accepted completion attempts scheduling home and finish in order`() {
    assertTrue(source.contains("internal fun completeAcceptedBootstrap("))
    val body = functionBody("internal fun completeAcceptedBootstrap")
    val periodicIndex = body.indexOf("step = \"periodic-refresh-sync\"")
    val followUpIndex = body.indexOf("step = \"follow-up-enqueue\"")
    val homeIndex = body.indexOf("step = \"home-launch\"")
    val finallyIndex = body.indexOf("finally")
    val finishIndex = body.indexOf("finish()")
    val finishCatchIndex = body.indexOf("catch (error: Throwable)", finishIndex)
    val finishReportIndex = body.indexOf("runCatching { reportFailure(\"finish\", error) }", finishCatchIndex)

    assertTrue(periodicIndex >= 0, "periodic refresh synchronization must be attempted")
    assertTrue(followUpIndex > periodicIndex, "follow-up enqueue must follow periodic synchronization")
    assertTrue(homeIndex > followUpIndex, "HOME launch must follow follow-up enqueue")
    assertTrue(finallyIndex > homeIndex, "finish must be owned by a final completion boundary")
    assertTrue(finishIndex > finallyIndex, "finish must run from finally")
    assertTrue(finishCatchIndex > finishIndex, "finish failure must be caught inside finally")
    assertTrue(finishReportIndex > finishCatchIndex, "finish failure reporting must not escape")
    assertTrue(body.windowed("finish()".length).count { it == "finish()" } == 1)
  }

  @Test
  fun `accepted completion isolates each step and failure reporting`() {
    assertTrue(source.contains("private inline fun attemptBootstrapCompletionStep("))
    val body = functionBody("private inline fun attemptBootstrapCompletionStep")

    assertTrue(body.contains("try"))
    assertTrue(body.contains("action()"))
    assertTrue(body.contains("catch (error: Throwable)"))
    assertTrue(body.contains("runCatching { reportFailure(step, error) }"))
  }

  @Test
  fun `accepted completion continues when every step and reporter fails`() {
    val events = mutableListOf<String>()
    var finishCount = 0

    val result = runCatching {
      completeAcceptedBootstrap(
        syncPeriodicRefresh = {
          events += "periodic-refresh-sync"
          error("periodic failed")
        },
        enqueueFollowUp = {
          events += "follow-up-enqueue"
          error("follow-up failed")
        },
        launchHome = {
          events += "home-launch"
          error("HOME failed")
        },
        finish = {
          finishCount += 1
          events += "finish"
        },
        reportFailure = { step, _ ->
          events += "report-$step"
          error("reporting failed")
        },
      )
    }

    assertTrue(result.isSuccess)
    assertEquals(1, finishCount)
    assertEquals(
      listOf(
        "periodic-refresh-sync",
        "report-periodic-refresh-sync",
        "follow-up-enqueue",
        "report-follow-up-enqueue",
        "home-launch",
        "report-home-launch",
        "finish",
      ),
      events,
    )
  }

  @Test
  fun `throwing finish and reporter cannot block the next completion`() {
    val events = mutableListOf<String>()

    fun deliver(label: String) {
      completeAcceptedBootstrap(
        syncPeriodicRefresh = { events += "$label-periodic" },
        enqueueFollowUp = { events += "$label-follow-up" },
        launchHome = { events += "$label-home" },
        finish = {
          events += "$label-finish"
          error("$label finish failed")
        },
        reportFailure = { step, _ ->
          events += "$label-report-$step"
          error("$label reporting failed")
        },
      )
    }

    val first = runCatching { deliver("first") }
    val second = runCatching { deliver("second") }

    assertTrue(first.isSuccess)
    assertTrue(second.isSuccess)
    assertEquals(
      listOf(
        "first-periodic",
        "first-follow-up",
        "first-home",
        "first-finish",
        "first-report-finish",
        "second-periodic",
        "second-follow-up",
        "second-home",
        "second-finish",
        "second-report-finish",
      ),
      events,
    )
  }

  @Test
  fun `new Intent replaces Activity intent before callback submission`() {
    val body = functionBody("override fun onNewIntent")
    val setIntentIndex = body.indexOf("setIntent(intent)")
    val dispatchIndex = body.indexOf("handleBootstrapIntent(intent)")

    assertTrue(setIntentIndex >= 0)
    assertTrue(dispatchIndex > setIntentIndex)
  }

  @Test
  fun `destroy detaches UI owner before Activity destruction`() {
    val body = functionBody("override fun onDestroy")
    val detachIndex = body.indexOf("NanoflowWidgetBootstrapProcessCoordinator.detach(")
    val superDestroyIndex = body.indexOf("super.onDestroy()")

    assertTrue(detachIndex >= 0, "destroy must detach the Activity owner")
    assertTrue(superDestroyIndex > detachIndex, "owner must detach before Activity destruction")
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
