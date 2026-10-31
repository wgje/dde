package app.nanoflow.host

import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NanoflowWidgetTelemetryTest {
  @Test
  fun `telemetry logs stable error type and never the throwable message`() {
    ShadowLog.clear()
    val secretMessage = "url=https://user:supersecret@example.com/path?token=widget-token-secret"
    NanoflowWidgetTelemetry.warn(
      "widget_test_secret_guard",
      mapOf("stage" to "token"),
      IllegalStateException(secretMessage),
    )

    val line = ShadowLog.getLogsForTag("NanoFlowWidget").single()
    assertTrue(line.msg.contains("widget_test_secret_guard"))
    assertTrue(line.msg.contains("IllegalStateException"))
    assertFalse(line.msg.contains(secretMessage))
    assertFalse(line.msg.contains("supersecret"))
    assertFalse(line.msg.contains("widget-token-secret"))
    assertFalse(line.msg.contains("https://user"))
  }

  @Test
  fun `error logs carry no raw throwable channel and keep stable error type`() {
    ShadowLog.clear()
    val secretMessage = "url=https://user:supersecret@example.com/path?token=widget-token-secret"
    NanoflowWidgetTelemetry.error(
      "widget_test_secret_error",
      mapOf("stage" to "token"),
      IllegalStateException(secretMessage),
    )

    val line = ShadowLog.getLogsForTag("NanoFlowWidget").single()
    assertNull(line.throwable)
    assertTrue(line.msg.contains("widget_test_secret_error"))
    assertTrue(line.msg.contains("IllegalStateException"))
    assertFalse(line.msg.contains(secretMessage))
    assertFalse(line.msg.contains("supersecret"))
    assertFalse(line.msg.contains("widget-token-secret"))
    assertFalse(line.msg.contains("https://user"))
  }
}
