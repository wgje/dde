package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetReceiverPackageReplaceContractTest {
  private val receiverSource: String by lazy { readSource("NanoflowWidgetReceiver.kt") }

  @Test
  fun `package replacement transfers exactly one asynchronous completion`() {
    val branch = blockAfter("Intent.ACTION_MY_PACKAGE_REPLACED ->")

    assertEquals(1, branch.countOccurrences("goAsync()"))
    assertTrue(branch.contains("NanoflowWidgetReceiverPendingCompletion("))
    assertTrue(branch.contains("completion.transfer { finish ->"))
    assertTrue(branch.contains("NanoflowWidgetPackageReinflateWorker.enqueue("))
    assertTrue(branch.contains("finish = finish"))
    assertFalse(branch.contains("pendingResult.finish()"))
  }

  @Test
  fun `package replacement contains no receiver-thread rendering or refresh work`() {
    val branch = blockAfter("Intent.ACTION_MY_PACKAGE_REPLACED ->")

    listOf(
      "runBlocking",
      "reinflateAllWidgets",
      "NanoflowWidgetStore",
      "NanoflowWidgetRepository",
      "NanoflowWidgetRenderer",
      "NanoflowWidgetRefreshWorker.enqueue",
    ).forEach { forbidden ->
      assertFalse(branch.contains(forbidden), "package replacement must not contain $forbidden")
    }
    assertFalse(receiverSource.contains("fun reinflateAllWidgets("))
  }

  @Test
  fun `package worker uses KEEP watchdog and existing full renderer`() {
    val workerSource = readSource("NanoflowWidgetPackageReinflateWorker.kt")

    assertTrue(workerSource.contains("ExistingWorkPolicy.KEEP"))
    assertTrue(workerSource.contains("HANDOFF_WATCHDOG_MS = 8_000L"))
    assertTrue(workerSource.contains("enqueueUniqueWork("))
    assertTrue(workerSource.contains("renderAndApplyWidget("))
    assertTrue(workerSource.contains("partialUpdate = false"))
    assertTrue(workerSource.contains("notifyActionListsDataChanged("))
    assertTrue(workerSource.contains("NanoflowWidgetRefreshWorker.enqueue("))
    assertTrue(workerSource.contains("operation-observer-failed"))
    assertFalse(workerSource.contains("NanoflowWidgetStore("))
    assertFalse(workerSource.contains("NanoflowWidgetRenderer."))
  }

  @Test
  fun `package replacement files remain below their physical line caps`() {
    assertTrue(receiverSource.lineSequence().count() < 800)
    assertTrue(readSource("NanoflowWidgetPackageReinflateWorker.kt").lineSequence().count() < 400)
    assertTrue(readSource("NanoflowWidgetPackageReinflateWorkerTest.kt").lineSequence().count() < 500)
    assertTrue(readSource("NanoflowWidgetReceiverPackageReplaceContractTest.kt").lineSequence().count() < 300)
  }

  private fun blockAfter(marker: String): String {
    val markerIndex = receiverSource.indexOf(marker)
    check(markerIndex >= 0) { "Missing marker: $marker" }
    val openBrace = receiverSource.indexOf('{', markerIndex + marker.length)
    check(openBrace >= 0) { "Missing block after: $marker" }
    var depth = 0
    var index = openBrace
    var state = ScanState.CODE
    while (index < receiverSource.length) {
      val current = receiverSource[index]
      val next = receiverSource.getOrNull(index + 1)
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
            if (depth == 0) return receiverSource.substring(openBrace + 1, index)
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
    error("Unterminated block after: $marker")
  }

  private fun readSource(fileName: String): String {
    val candidates = listOf(
      Path.of("src/main/java/app/nanoflow/host/$fileName"),
      Path.of("src/test/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/test/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/test/java/app/nanoflow/host/$fileName"),
    )
    val sourcePath = candidates.firstOrNull(Files::exists)
      ?: error("$fileName was not found from ${Path.of("").toAbsolutePath()}")
    return sourcePath.toFile().readText()
  }

  private fun String.countOccurrences(needle: String): Int {
    if (needle.isEmpty()) return 0
    var count = 0
    var start = 0
    while (true) {
      val index = indexOf(needle, start)
      if (index < 0) return count
      count += 1
      start = index + needle.length
    }
  }

  private enum class ScanState {
    CODE,
    LINE_COMMENT,
    BLOCK_COMMENT,
    STRING,
    CHAR,
  }
}
