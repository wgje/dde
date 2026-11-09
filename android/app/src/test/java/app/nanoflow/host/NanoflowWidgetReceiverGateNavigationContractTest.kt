package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetReceiverGateNavigationContractTest {
  private val source: String by lazy {
    val candidates = listOf(
      Path.of("src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt"),
      Path.of("app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt"),
      Path.of("android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt"),
    )
    val sourcePath = candidates.firstOrNull(Files::exists)
      ?: error("NanoflowWidgetReceiver.kt was not found from ${Path.of("").toAbsolutePath()}")
    sourcePath.toFile().readText()
  }

  @Test
  fun `zero delta returns before asynchronous ownership transfer`() {
    val body = functionBody("private fun handleGateNav")
    val guardIndex = body.indexOf("if (delta == 0) return")
    val goAsyncIndex = body.indexOf("goAsync()")
    val submitIndex = body.indexOf("NanoflowWidgetGateNavigationProcessCoordinator.submit(")

    assertTrue(guardIndex >= 0)
    assertTrue(goAsyncIndex > guardIndex)
    assertTrue(submitIndex > goAsyncIndex)
  }

  @Test
  fun `nonzero navigation delegates sole PendingResult ownership`() {
    val body = functionBody("private fun handleGateNav")

    assertTrue(body.contains("val pendingResult = goAsync()"))
    assertTrue(body.contains("finish = pendingResult::finish"))
    assertFalse(body.contains("pendingResult.finish()"))
    assertFalse(Regex("""\brunBlocking\s*\{""").containsMatchIn(body))
  }

  @Test
  fun `Receiver performs no gate navigation persistence or render work`() {
    val body = functionBody("private fun handleGateNav")

    assertFalse(body.contains("NanoflowWidgetRepository"))
    assertFalse(body.contains("shiftGatePage"))
    assertFalse(body.contains("AppWidgetManager"))
    assertFalse(body.contains("renderAndApply"))
    assertFalse(body.contains("notifyActionListsDataChanged"))
  }

  @Test
  fun `Receiver remains below the physical line cap`() {
    assertTrue(source.lineSequence().count() < 800)
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
