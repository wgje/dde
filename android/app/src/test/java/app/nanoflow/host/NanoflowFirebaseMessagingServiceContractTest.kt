package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowFirebaseMessagingServiceContractTest {
  private val service = readSource("NanoflowFirebaseMessagingService.kt")
  private val worker = readSource("NanoflowWidgetFocusHintWorker.kt")

  @Test
  fun `service owns no blocking repository or render work`() {
    assertFalse(service.contains("runBlocking"))
    assertFalse(service.contains("NanoflowWidgetRepository"))
    assertFalse(service.contains("refreshAllWidgets"))
    assertTrue(service.contains("NanoflowWidgetFocusHintWorker.enqueueIfComplete("))
  }

  @Test
  fun `hint submission and authoritative refresh have independent failure boundaries`() {
    val messageBody = blockAfter(service, "override fun onMessageReceived")
    assertTrue(messageBody.contains("nanoflowWidgetAttemptSafely"))
    assertFalse(messageBody.contains(".onFailure"))
    assertTrue(messageBody.contains("NanoflowWidgetFocusHintWorker.enqueueIfComplete("))
    assertTrue(messageBody.contains("NanoflowWidgetRefreshWorker.enqueue("))
    assertTrue(
      messageBody.indexOf("NanoflowWidgetFocusHintWorker.enqueueIfComplete(") <
        messageBody.lastIndexOf("NanoflowWidgetRefreshWorker.enqueue("),
    )
  }

  @Test
  fun `new token is synchronously deduped without token input or telemetry`() {
    val tokenBody = blockAfter(service, "override fun onNewToken")
    assertTrue(tokenBody.contains("rememberPushTokenSynchronously(token)"))
    assertTrue(tokenBody.contains("NanoflowWidgetRefreshWorker.enqueue("))
    assertTrue(tokenBody.contains("nanoflowWidgetAttemptSafely"))
    assertFalse(tokenBody.contains(".onFailure"))
    assertFalse(tokenBody.contains("setInputData"))
    assertFalse(tokenBody.contains("\"token\" to token"))
  }

  @Test
  fun `throwing failure reporter cannot suppress the following refresh attempt`() {
    val events = mutableListOf<String>()

    nanoflowWidgetAttemptSafely(
      action = {
        events += "hint"
        error("hint enqueue failed")
      },
      reportFailure = {
        events += "report"
        error("telemetry failed")
      },
    )
    nanoflowWidgetAttemptSafely(action = { events += "refresh" })

    assertEquals(listOf("hint", "report", "refresh"), events)
  }

  @Test
  fun `worker consumes only released protocol keys`() {
    listOf(
      "focusActiveHint",
      "focusSessionHint",
      "focusRevisionMicrosHint",
      "focusEventIdHint",
      "focusDeviceIdHint",
      "focusBindingGenerationHint",
    ).forEach { key -> assertTrue(worker.contains("\"$key\""), "missing $key") }
    listOf(
      "focusHintRevisionMicros",
      "focusHintEventId",
      "focusHintDeviceId",
      "focusHintBindingGeneration",
    ).forEach { alias -> assertFalse(worker.contains("\"$alias\""), "legacy alias $alias") }
  }

  @Test
  fun `all exact-seven files stay within approved scope and caps`() {
    assertTrue(readSource("build.gradle.kts").lineSequence().count() < 200)
    assertTrue(service.lineSequence().count() < 130)
    assertTrue(worker.lineSequence().count() < 350)
    assertTrue(readSource("NanoflowWidgetStore.kt").lineSequence().count() < 800)
    assertTrue(readSource("NanoflowWidgetRepository.kt").isNotBlank())
    assertTrue(readSource("NanoflowWidgetFocusHintWorkerTest.kt").lineSequence().count() < 750)
    assertTrue(readSource("NanoflowFirebaseMessagingServiceContractTest.kt").lineSequence().count() < 250)
  }

  private fun blockAfter(source: String, marker: String): String {
    val markerIndex = source.indexOf(marker)
    check(markerIndex >= 0) { "Missing marker: $marker" }
    val openBrace = source.indexOf('{', markerIndex)
    check(openBrace >= 0) { "Missing block after: $marker" }
    var depth = 0
    var index = openBrace
    while (index < source.length) {
      when (source[index]) {
        '{' -> depth += 1
        '}' -> {
          depth -= 1
          if (depth == 0) return source.substring(openBrace + 1, index)
        }
      }
      index += 1
    }
    error("Unterminated block after: $marker")
  }

  private fun readSource(fileName: String): String {
    val candidates = listOf(
      Path.of(fileName),
      Path.of("app/$fileName"),
      Path.of("android/app/$fileName"),
      Path.of("src/main/java/app/nanoflow/host/$fileName"),
      Path.of("src/test/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/test/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/test/java/app/nanoflow/host/$fileName"),
    )
    return candidates.firstOrNull(Files::exists)?.toFile()?.readText()
      ?: error("$fileName was not found")
  }
}
