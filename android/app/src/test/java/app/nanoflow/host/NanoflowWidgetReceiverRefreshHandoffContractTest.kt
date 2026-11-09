package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetReceiverRefreshHandoffContractTest {
  private val receiver = readSource("NanoflowWidgetReceiver.kt")
  private val worker = readSource("NanoflowWidgetRefreshWorker.kt")
  private val coordinator = readSource("NanoflowWidgetRefreshHandoffCoordinator.kt")

  @Test
  fun `force and widget click refresh each acquire one independent completion`() {
    val onReceive = blockAfter(receiver, "override fun onReceive")
    val clickDispatch = blockAfter(receiver, "private fun handleClickItem")
    val clickRefresh = blockAfter(receiver, "private fun handleRefresh")
    val handoff = blockAfter(receiver, "private fun submitRefreshHandoff")
    val clickEntry = onReceive.substringAfter("ACTION_CLICK_ITEM ->")
      .substringBefore("ACTION_FORCE_REFRESH ->")

    assertTrue(onReceive.contains("ACTION_FORCE_REFRESH -> submitRefreshHandoff("))
    assertTrue(clickDispatch.contains("ITEM_TYPE_REFRESH -> handleRefresh("))
    assertTrue(clickRefresh.contains("submitRefreshHandoff("))
    assertFalse(clickEntry.contains("resetReactiveRefreshGate"))
    assertTrue(clickDispatch.contains("itemType != NanoflowWidgetActionFactory.ITEM_TYPE_REFRESH"))
    val submitIndex = clickRefresh.indexOf("submitRefreshHandoff(")
    assertTrue(submitIndex >= 0)
    assertTrue(clickRefresh.indexOf("resetReactiveRefreshGate", submitIndex) > submitIndex)
    assertTrue(clickRefresh.indexOf("NanoflowWidgetTelemetry.info", submitIndex) > submitIndex)
    assertEquals(1, handoff.countOccurrences("goAsync()"))
    assertTrue(handoff.contains("NanoflowWidgetRefreshHandoffProcessCoordinator.submit("))
    assertTrue(handoff.contains("pendingResult::finish"))
  }

  @Test
  fun `receiver handoff contains no blocking network repository or render work`() {
    val handoff = blockAfter(receiver, "private fun submitRefreshHandoff")
    listOf(
      "runBlocking",
      "NanoflowWidgetRepository",
      "NanoflowWidgetStore",
      "renderAndApplyWidget",
      "enqueueUniqueWork",
    ).forEach { forbidden ->
      assertFalse(handoff.contains(forbidden), "refresh receiver handoff must not contain $forbidden")
    }
    assertFalse(blockAfter(receiver, "private fun handleRefresh").contains("NanoflowWidgetRefreshWorker.enqueue"))
  }

  @Test
  fun `tracked enqueue preserves the existing UUID API and exposes Operation`() {
    val enqueue = blockAfter(worker, "fun enqueue(context: Context, reason: String)")
    val tracked = blockAfter(worker, "fun enqueueTracked(context: Context, reason: String)")

    assertTrue(enqueue.contains("enqueueTracked(context, reason).requestId"))
    assertTrue(tracked.contains("enqueueUniqueWork("))
    assertTrue(tracked.contains("NanoflowWidgetRefreshTrackedEnqueue("))
    assertTrue(coordinator.contains("val operation: Operation"))
  }

  @Test
  fun `watchdog is scheduled before observation and settlement releases callbacks`() {
    val submit = blockAfter(coordinator, "fun submit(")
    val schedule = submit.indexOf("scheduleWatchdog(")
    val observe = submit.indexOf("observeOperation(")

    assertTrue(schedule >= 0)
    assertTrue(observe > schedule)
    assertTrue(coordinator.contains("AtomicReference<Callbacks?>"))
    assertTrue(coordinator.contains("getAndSet(null)"))
    assertFalse(coordinator.contains("operation.cancel"))
    assertFalse(coordinator.contains("operation.result.cancel"))
  }

  @Test
  fun `exact five files retain approved physical caps`() {
    assertTrue(receiver.lineSequence().count() < 800)
    assertTrue(worker.lineSequence().count() < 420)
    assertTrue(coordinator.lineSequence().count() < 220)
    assertTrue(readSource("NanoflowWidgetRefreshHandoffCoordinatorTest.kt").lineSequence().count() < 450)
    assertTrue(readSource("NanoflowWidgetReceiverRefreshHandoffContractTest.kt").lineSequence().count() < 260)
  }

  private fun blockAfter(source: String, marker: String): String {
    val markerIndex = source.indexOf(marker)
    check(markerIndex >= 0) { "Missing marker: $marker" }
    val openBrace = source.indexOf('{', markerIndex)
    check(openBrace >= 0) { "Missing block after: $marker" }
    var depth = 0
    for (index in openBrace until source.length) {
      when (source[index]) {
        '{' -> depth += 1
        '}' -> if (--depth == 0) return source.substring(openBrace + 1, index)
      }
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
    return candidates.firstOrNull(Files::exists)?.toFile()?.readText()
      ?: error("$fileName was not found")
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
}
