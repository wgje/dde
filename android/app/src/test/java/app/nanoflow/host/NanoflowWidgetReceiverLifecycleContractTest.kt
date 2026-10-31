package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetReceiverLifecycleContractTest {
  private val source: String by lazy {
    readSource("NanoflowWidgetReceiver.kt")
  }

  @Test
  fun `lifecycle callbacks transfer one asynchronous completion and return`() {
    val callbacks = mapOf(
      "onUpdate" to functionBody("override fun onUpdate"),
      "onAppWidgetOptionsChanged" to functionBody("override fun onAppWidgetOptionsChanged"),
      "onDeleted" to functionBody("override fun onDeleted"),
      "onDisabled" to functionBody("override fun onDisabled"),
    )

    callbacks.forEach { (name, body) ->
      assertTrue(body.contains("val pendingResult = goAsync()"), "$name must call goAsync exactly once")
      assertEquals(1, body.countOccurrences("goAsync()"), "$name must own one PendingResult")
      val finishTransfer = if (name == "onDeleted") {
        "finishCallback = pendingResult::finish"
      } else {
        "finish = pendingResult::finish"
      }
      assertTrue(body.contains(finishTransfer), "$name must transfer finish ownership")
      assertFalse(body.contains("pendingResult.finish()"), "$name must not finish in Receiver")
    }
  }

  @Test
  fun `Receiver snapshots callback inputs before FIFO submission`() {
    val update = functionBody("override fun onUpdate")
    val optionsChanged = functionBody("override fun onAppWidgetOptionsChanged")
    val deleted = functionBody("override fun onDeleted")

    assertTrue(update.contains("appWidgetIds.copyOf()"))
    assertTrue(optionsChanged.contains("Bundle(newOptions)"))
    assertTrue(deleted.contains("appWidgetIds.copyOf()"))
    val goAsyncIndex = deleted.indexOf("val pendingResult = goAsync()")
    val lookupIndex = deleted.indexOf("val hasWidgetsRemaining = hasInstalledWidgets(context)")
    val submitIndex = deleted.indexOf("submitDeleted(")
    assertTrue(goAsyncIndex >= 0)
    assertTrue(goAsyncIndex < lookupIndex)
    assertTrue(lookupIndex < submitIndex)
    assertTrue(deleted.contains("NanoflowWidgetReceiverPendingCompletion("))
    assertTrue(deleted.contains("completion.transfer { finish ->"))
    assertTrue(deleted.contains("finish = finish"))
  }

  @Test
  fun `deleted pre-submission failure finishes once and later FIFO callback continues`() = runBlocking {
    val reports = AtomicInteger()
    val deletedFinish = AtomicInteger()
    val laterFinish = AtomicInteger()
    val laterFinished = CompletableDeferred<Unit>()
    val completion = NanoflowWidgetReceiverPendingCompletion(
      finishCallback = {
        deletedFinish.incrementAndGet()
        error("PendingResult finish failed")
      },
      reportFailure = {
        reports.incrementAndGet()
        error("reporter failed")
      },
    )

    val transfer = runCatching {
      completion.transfer { error("remaining-widget lookup failed") }
    }
    completion.finish()

    val coordinator = NanoflowWidgetLifecycleCallbackCoordinator(
      scope = this,
      processingContext = EmptyCoroutineContext,
    )
    coordinator.submit(
      work = { attempt {} },
      finish = {
        laterFinish.incrementAndGet()
        laterFinished.complete(Unit)
      },
    )

    withTimeout(2_000) { laterFinished.await() }
    assertTrue(transfer.isSuccess)
    assertTrue(reports.get() >= 2)
    assertEquals(1, deletedFinish.get())
    assertEquals(1, laterFinish.get())
  }

  @Test
  fun `Receiver lifecycle callbacks contain no blocking persistence or render work`() {
    listOf(
      "override fun onUpdate",
      "override fun onAppWidgetOptionsChanged",
      "override fun onDeleted",
      "override fun onDisabled",
    ).forEach { signature ->
      val body = functionBody(signature)
      assertFalse(Regex("""\brunBlocking\s*\{""").containsMatchIn(body), signature)
      assertFalse(body.contains("NanoflowWidgetStore"), signature)
      assertFalse(body.contains("NanoflowWidgetRepository"), signature)
      assertFalse(body.contains("renderAndApply"), signature)
      assertFalse(body.contains("syncPeriodicRefresh"), signature)
    }
  }

  @Test
  fun `Receiver keeps the existing single super onReceive dispatch`() {
    assertEquals(1, source.countOccurrences("super.onReceive(context, intent)"))
    assertFalse(source.contains("super.onUpdate("))
    assertFalse(source.contains("super.onAppWidgetOptionsChanged("))
    assertFalse(source.contains("super.onDeleted("))
    assertFalse(source.contains("super.onDisabled("))
  }

  @Test
  fun `Receiver remains below the physical line cap`() {
    assertTrue(source.lineSequence().count() < 800)
  }

  private fun readSource(fileName: String): String {
    val candidates = listOf(
      Path.of("src/main/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/main/java/app/nanoflow/host/$fileName"),
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

  private fun functionBody(signature: String): String {
    val signatureIndex = source.indexOf(signature)
    check(signatureIndex >= 0) { "Missing function signature: $signature" }
    val openBrace = functionBodyOpenBrace(signatureIndex)
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
            if (depth == 0) return source.substring(openBrace + 1, index)
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

  private fun functionBodyOpenBrace(signatureIndex: Int): Int {
    val parameterOpen = source.indexOf('(', signatureIndex)
    check(parameterOpen >= 0) { "Missing function parameters" }

    var depth = 0
    var index = parameterOpen
    while (index < source.length) {
      when (source[index]) {
        '(' -> depth += 1
        ')' -> {
          depth -= 1
          if (depth == 0) return source.indexOf('{', index + 1)
        }
      }
      index += 1
    }
    return -1
  }

  private enum class ScanState {
    CODE,
    LINE_COMMENT,
    BLOCK_COMMENT,
    STRING,
    CHAR,
  }
}
