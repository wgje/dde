package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetReceiverFocusMutationContractTest {
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
  fun `focus mutation entry points never block the Receiver thread`() {
    listOf("private fun handleFocusAction", "private fun handleSelectTask").forEach { signature ->
      val body = functionBody(signature)

      assertTrue(body.contains("goAsync()"), "$signature must protect asynchronous work with goAsync")
      assertFalse(Regex("""\brunBlocking\s*\{""").containsMatchIn(body))
      assertFalse(body.contains("silentActionScope.launch"))
    }
  }

  @Test
  fun `focus mutation entry points delegate persistence to the process coordinator`() {
    val focusBody = functionBody("private fun handleFocusAction")
    val selectBody = functionBody("private fun handleSelectTask")

    assertTrue(focusBody.contains("NanoflowWidgetFocusMutationProcessCoordinator.submitFocusAction("))
    assertTrue(selectBody.contains("NanoflowWidgetFocusMutationProcessCoordinator.submitSelectTask("))
    listOf(focusBody, selectBody).forEach { body ->
      assertFalse(body.contains("NanoflowWidgetRepository"))
      assertFalse(body.contains("applyOptimisticFocus"))
      assertFalse(body.contains("rollbackOptimisticFocusPromotion"))
      assertFalse(body.contains("pendingResult.finish()"))
    }
  }

  @Test
  fun `Receiver remains a bounded owner adapter`() {
    assertTrue(source.lineSequence().count() < 800, "Receiver must stay below 800 physical lines")
  }

  @Test
  fun `widget apply is committed through the coordinator generation lock`() {
    val body = functionBody("suspend fun renderAndApplyWidget")
    val commitIndex = body.indexOf("commitIfCurrent {")
    val partialApplyIndex = body.indexOf("appWidgetManager.partiallyUpdateAppWidget")
    val fullApplyIndex = body.indexOf("appWidgetManager.updateAppWidget")

    assertTrue(commitIndex >= 0, "widget apply must enter the generation commit lock")
    assertTrue(partialApplyIndex > commitIndex)
    assertTrue(fullApplyIndex > commitIndex)
    assertFalse(body.contains("shouldApply"))
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

  private fun functionBodyOpenBrace(signatureIndex: Int): Int {
    val parameterOpen = source.indexOf('(', signatureIndex)
    check(parameterOpen >= 0) { "Missing function parameters" }

    var depth = 0
    var index = parameterOpen
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
          current == '(' -> depth += 1
          current == ')' -> {
            depth -= 1
            if (depth == 0) {
              return source.indexOf('{', index + 1)
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
