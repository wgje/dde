package app.nanoflow.host

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

object NanoflowWidgetTelemetry {
  private const val TAG = "NanoFlowWidget"

  fun redactId(value: String?): String? {
    if (value.isNullOrBlank()) {
      return null
    }

    return if (value.length <= 8) value else "${value.take(8)}..."
  }

  fun info(event: String, fields: Map<String, Any?> = emptyMap()) {
    log(Log.INFO, event, fields)
  }

  fun warn(event: String, fields: Map<String, Any?> = emptyMap(), error: Throwable? = null) {
    log(Log.WARN, event, fields, error)
  }

  fun error(event: String, fields: Map<String, Any?> = emptyMap(), error: Throwable? = null) {
    log(Log.ERROR, event, fields, error)
  }

  private fun log(priority: Int, event: String, fields: Map<String, Any?>, error: Throwable? = null) {
    val payload = JSONObject().apply {
      put("event", event)
      put("at", Instant.now().toString())
      fields.toSortedMap().forEach { (key, value) ->
        put(key, normalizeValue(value))
      }
      if (error != null) {
        put("error", error.message ?: error.javaClass.simpleName)
      }
    }

    when (priority) {
      Log.ERROR -> Log.e(TAG, payload.toString(), error)
      Log.WARN -> Log.w(TAG, payload.toString())
      else -> Log.i(TAG, payload.toString())
    }
  }

  private fun normalizeValue(value: Any?): Any {
    return when (value) {
      null -> JSONObject.NULL
      is Number, is Boolean, is String -> value
      is Enum<*> -> value.name.lowercase()
      is Map<*, *> -> JSONObject().apply {
        value.entries.forEach { (key, nestedValue) ->
          if (key is String) {
            put(key, normalizeValue(nestedValue))
          }
        }
      }
      is Iterable<*> -> JSONArray(value.map { item -> normalizeValue(item) })
      is Array<*> -> JSONArray(value.map { item -> normalizeValue(item) })
      else -> value.toString()
    }
  }
}
