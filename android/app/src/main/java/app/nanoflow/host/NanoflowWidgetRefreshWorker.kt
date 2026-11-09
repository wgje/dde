package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Operation
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit
import java.util.UUID
import kotlinx.serialization.json.Json

internal class NanoflowWidgetAuthoritativeRefreshAttemptRegistry :
  NanoflowWidgetAuthoritativeRefreshAttemptRegistryCore()

internal class NanoflowWidgetAuthoritativeStatePreferences(
  private val json: Json,
  private val cacheVersion: Int,
) {
  fun summaryJsonKey(id: Int) = stringPreferencesKey("summary.$id.json")
  fun summaryVersionKey(id: Int) = intPreferencesKey("summary.$id.cacheFormatVersion")
  fun summaryUpdatedKey(id: Int) = longPreferencesKey("summary.$id.updatedAt")
  private fun ownerDeviceKey(id: Int) = stringPreferencesKey("summary.$id.ownerDeviceId")
  private fun ownerGenerationKey(id: Int) = intPreferencesKey("summary.$id.ownerGeneration")
  private fun ownerEpochKey(id: Int) = longPreferencesKey("summary.$id.ownerEpoch")
  private val backoffUntilKey = longPreferencesKey("rateLimit.backoffUntilMs")
  private val backoffDeviceKey = stringPreferencesKey("rateLimit.ownerDeviceId")
  private val backoffGenerationKey = intPreferencesKey("rateLimit.ownerGeneration")
  private val backoffEpochKey = longPreferencesKey("rateLimit.ownerEpoch")

  fun save(
    prefs: MutablePreferences,
    ticket: NanoflowWidgetAuthoritativeRefreshTicket,
    summary: WidgetSummaryResponse,
  ) {
    val durable = if (prefs[androidx.datastore.preferences.core.booleanPreferencesKey("settings.privacyMode")] == true) {
      stripSensitiveWidgetSummary(summary)
    } else summary
    val id = ticket.appWidgetId
    prefs[summaryJsonKey(id)] = json.encodeToString(WidgetSummaryResponse.serializer(), durable)
    prefs[summaryVersionKey(id)] = cacheVersion
    prefs[summaryUpdatedKey(id)] = System.currentTimeMillis()
    prefs[ownerEpochKey(id)] = ticket.bindingEpoch
    if (ticket.owner == null) {
      prefs.remove(ownerDeviceKey(id))
      prefs.remove(ownerGenerationKey(id))
    } else {
      prefs[ownerDeviceKey(id)] = ticket.owner.deviceId
      prefs[ownerGenerationKey(id)] = ticket.owner.bindingGeneration
    }
  }

  fun ownerMatches(prefs: Preferences, id: Int, owner: NanoflowWidgetBindingIdentity?, epoch: Long): Boolean =
    prefs[ownerEpochKey(id)] == epoch && prefs[ownerDeviceKey(id)] == owner?.deviceId &&
      prefs[ownerGenerationKey(id)] == owner?.bindingGeneration

  fun removeOwner(prefs: MutablePreferences, id: Int) {
    prefs.remove(ownerDeviceKey(id))
    prefs.remove(ownerGenerationKey(id))
    prefs.remove(ownerEpochKey(id))
  }

  fun clearWidget(prefs: MutablePreferences, id: Int) {
    prefs.remove(summaryJsonKey(id))
    prefs.remove(summaryVersionKey(id))
    prefs.remove(summaryUpdatedKey(id))
    removeOwner(prefs, id)
  }

  fun clearBindingScopedState(prefs: MutablePreferences, id: Int) {
    prefs.remove(instanceIdKey(id))
    clearWidget(prefs, id)
    NanoflowWidgetFocusHintPreferences.remove(prefs, id)
    prefs.remove(pendingFocusMutationActionKey(id))
    prefs.remove(pendingFocusMutationIssuedAtKey(id))
    prefs.remove(stringPreferencesKey("instance.bootstrapNonce.$id"))
    prefs.remove(longPreferencesKey("instance.bootstrapIssuedAt.$id"))
    prefs.remove(stringPreferencesKey("instance.bootstrapPushToken.$id"))
  }

  fun readAuthoritativeSummary(
    prefs: Preferences,
    id: Int,
    owner: NanoflowWidgetBindingIdentity?,
    epoch: Long,
  ): WidgetSummaryResponse? {
    if (!ownerMatches(prefs, id, owner, epoch) || prefs[summaryVersionKey(id)] != cacheVersion) return null
    val raw = prefs[summaryJsonKey(id)] ?: return null
    return runCatching { json.decodeFromString(WidgetSummaryResponse.serializer(), raw) }.getOrNull()
  }

  fun clearMismatched(prefs: MutablePreferences, owner: NanoflowWidgetBindingIdentity?, epoch: Long) {
    prefs.asMap().keys.mapNotNull { it.name.removePrefix("summary.").removeSuffix(".json").toIntOrNull() }
      .distinct().forEach { id ->
        if (!ownerMatches(prefs, id, owner, epoch)) {
          prefs.remove(summaryJsonKey(id))
          prefs.remove(summaryVersionKey(id))
          prefs.remove(summaryUpdatedKey(id))
          removeOwner(prefs, id)
        }
      }
    if (!backoffMatches(prefs, owner, epoch)) clearBackoff(prefs)
  }

  fun persistBackoff(prefs: MutablePreferences, ticket: NanoflowWidgetAuthoritativeRefreshTicket, seconds: Int) {
    prefs[backoffUntilKey] = System.currentTimeMillis() + seconds * 1000L
    prefs[backoffEpochKey] = ticket.bindingEpoch
    if (ticket.owner == null) {
      prefs.remove(backoffDeviceKey)
      prefs.remove(backoffGenerationKey)
    } else {
      prefs[backoffDeviceKey] = ticket.owner.deviceId
      prefs[backoffGenerationKey] = ticket.owner.bindingGeneration
    }
  }

  fun backoffUntil(prefs: Preferences, owner: NanoflowWidgetBindingIdentity?, epoch: Long): Long? =
    prefs[backoffUntilKey]?.takeIf { backoffMatches(prefs, owner, epoch) }

  fun clearBackoff(prefs: MutablePreferences) {
    prefs.remove(backoffUntilKey)
    prefs.remove(backoffDeviceKey)
    prefs.remove(backoffGenerationKey)
    prefs.remove(backoffEpochKey)
  }

  fun applyRenderPreparation(
    prefs: MutablePreferences,
    id: Int,
    preparation: NanoflowWidgetAuthoritativeRenderPreparation,
    beforeFocusHintClear: () -> Unit,
  ) {
    preparation.sizeBucket?.let { prefs[stringPreferencesKey("instance.$id.sizeBucket")] = it }
    if (preparation.gateSelectionChanged) {
      prefs[intPreferencesKey("instance.$id.gatePageIndex")] = preparation.gatePageIndex
      val selectedKey = stringPreferencesKey("instance.$id.gateSelectedEntryId")
      preparation.gateSelectedEntryId?.let { prefs[selectedKey] = it } ?: prefs.remove(selectedKey)
    }
    val expected = preparation.clearFocusHint ?: return
    val current = NanoflowWidgetFocusHintPreferences.read(prefs, id)
    val hint = current?.hint
    if (current?.issuedAtMs != expected.issuedAtMs || hint?.eventId != expected.eventId ||
      hint.revisionMicros != expected.revisionMicros || hint.deviceId != expected.deviceId ||
      hint.bindingGeneration != expected.bindingGeneration
    ) return
    beforeFocusHintClear()
    NanoflowWidgetFocusHintPreferences.write(prefs, id, current.copy(projectable = false))
  }

  private fun backoffMatches(prefs: Preferences, owner: NanoflowWidgetBindingIdentity?, epoch: Long): Boolean =
    prefs[backoffEpochKey] == epoch && prefs[backoffDeviceKey] == owner?.deviceId &&
      prefs[backoffGenerationKey] == owner?.bindingGeneration
}

class NanoflowWidgetRefreshWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
  override suspend fun doWork(): Result {
    val repository = NanoflowWidgetRepository(applicationContext)
    val appWidgetManager = AppWidgetManager.getInstance(applicationContext)
    val reason = inputData.getString("reason") ?: "unknown"
    NanoflowWidgetTelemetry.info("widget_refresh_started", mapOf("reason" to reason))

    val outcome = NanoflowWidgetRefreshOrchestrator(
      refresh = {
        repository.refreshInstalledWidgets()
      },
      render = { ticket ->
        val applied = NanoflowWidgetReceiver.renderAndApplyWidget(
          context = applicationContext,
          appWidgetManager = appWidgetManager,
          repository = repository,
          appWidgetId = ticket.appWidgetId,
          partialUpdate = true,
          authoritativeTicket = ticket,
          afterApply = {
            NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, ticket.appWidgetId)
          },
        )
        if (applied) ticket.commitIfCurrent {
          NanoflowWidgetTelemetry.info(
            "widget_refresh_succeeded",
            mapOf("reason" to reason, "appWidgetId" to ticket.appWidgetId),
          )
        }
      },
      ensureToken = { ensureFcmTokenPersisted(applicationContext) },
      reportFailure = { stage, error ->
        NanoflowWidgetTelemetry.warn(
          "widget_refresh_failed",
          mapOf("reason" to reason, "stage" to stage),
          error,
        )
      },
    ).run()
    return if (outcome == NanoflowWidgetRefreshOutcome.SUCCESS) Result.success() else Result.retry()
  }

  private suspend fun ensureFcmTokenPersisted(context: Context) {
    if (!BuildConfig.NANOFLOW_FCM_ENABLED) {
      // 未配置 google-services.json 的构建：跳过，避免 FirebaseApp 未初始化时抛异常。
      return
    }
    try {
      val token = withTimeoutOrNull(FCM_TOKEN_ENSURE_TIMEOUT_MS) {
        com.google.firebase.messaging.FirebaseMessaging.getInstance()
          .token
          .await()
      }
      if (token == null) {
        NanoflowWidgetTelemetry.warn(
          "widget_push_token_ensure_skipped",
          mapOf("reason" to "token-timeout", "timeoutMs" to FCM_TOKEN_ENSURE_TIMEOUT_MS),
        )
        return
      }
      if (token.isBlank()) {
        NanoflowWidgetTelemetry.warn(
          "widget_push_token_ensure_skipped",
          mapOf("reason" to "empty-token"),
        )
        return
      }
      NanoflowWidgetRepository(context).rememberPushToken(token)
      NanoflowWidgetTelemetry.info(
        "widget_push_token_ensured",
        mapOf("tokenLength" to token.length, "source" to "worker-post-refresh"),
      )
    } catch (error: Throwable) {
      error.rethrowCancellation()
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_ensure_failed",
        mapOf("errorClass" to (error::class.simpleName ?: "unknown")),
        error,
      )
    }
  }

  private fun Throwable.rethrowCancellation() {
    if (this is CancellationException) throw this
  }

  companion object {
    private const val UNIQUE_WORK_NAME = "nanoflow-widget-refresh"
    private const val UNIQUE_PERIODIC_WORK_NAME = "nanoflow-widget-refresh-periodic"
    private const val TWA_SESSION_BURST_WORK_PREFIX = "nanoflow-widget-twa-session-burst"
    private const val FOCUS_WAIT_REMINDER_WORK_PREFIX = "nanoflow-widget-focus-wait-reminder"
    private const val GATE_READ_COOLDOWN_REFRESH_WORK_PREFIX = "nanoflow-widget-gate-read-cooldown"
    private const val GATE_READ_REAPPEAR_COOLDOWN_MS = 30 * 60 * 1000L
    private const val FCM_TOKEN_ENSURE_TIMEOUT_MS = 2_000L
    private const val TWA_SESSION_BURST_PREFS = "nanoflow-widget-twa-session-burst"
    private const val TWA_SESSION_BURST_LAST_AT_KEY = "last_scheduled_at"
    private const val TWA_SESSION_BURST_MIN_INTERVAL_MS = 30_000L
    private val TWA_SESSION_BURST_DELAYS_SECONDS = longArrayOf(8, 20, 45, 90, 180, 300)

    fun enqueue(context: Context, reason: String): UUID {
      return enqueueTracked(context, reason).requestId
    }

    internal fun enqueueTracked(context: Context, reason: String): NanoflowWidgetRefreshTrackedEnqueue {
      NanoflowWidgetTelemetry.info("widget_refresh_enqueued", mapOf("reason" to reason))
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
        .setInputData(Data.Builder().putString("reason", reason).build())
        .build()

      val operation: Operation = WorkManager.getInstance(context).enqueueUniqueWork(
        UNIQUE_WORK_NAME,
        ExistingWorkPolicy.REPLACE,
        request,
      )
      return NanoflowWidgetRefreshTrackedEnqueue(request.id, operation)
    }

    fun scheduleTwaSessionRefreshBurst(context: Context, reason: String) {
      if (!NanoflowWidgetReceiver.hasInstalledWidgets(context)) {
        return
      }

      val prefs = context.applicationContext.getSharedPreferences(TWA_SESSION_BURST_PREFS, Context.MODE_PRIVATE)
      val nowMs = System.currentTimeMillis()
      val lastScheduledAt = prefs.getLong(TWA_SESSION_BURST_LAST_AT_KEY, 0L)
      val elapsedMs = nowMs - lastScheduledAt
      if (lastScheduledAt > 0L && elapsedMs < TWA_SESSION_BURST_MIN_INTERVAL_MS) {
        NanoflowWidgetTelemetry.info(
          "widget_twa_session_refresh_burst_throttled",
          mapOf(
            "reason" to reason,
            "elapsedMs" to elapsedMs,
            "minIntervalMs" to TWA_SESSION_BURST_MIN_INTERVAL_MS,
          ),
        )
        return
      }
      prefs.edit().putLong(TWA_SESSION_BURST_LAST_AT_KEY, nowMs).apply()

      val workManager = WorkManager.getInstance(context)
      TWA_SESSION_BURST_DELAYS_SECONDS.forEachIndexed { index, delaySeconds ->
        val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
          .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
          .setInputData(
            Data.Builder()
              .putString("reason", "$reason-${delaySeconds}s")
              .build(),
          )
          .build()

        workManager.enqueueUniqueWork(
          "$TWA_SESSION_BURST_WORK_PREFIX-$index",
          ExistingWorkPolicy.REPLACE,
          request,
        )
      }

      NanoflowWidgetTelemetry.info(
        "widget_twa_session_refresh_burst_scheduled",
        mapOf(
          "reason" to reason,
          "delaysSeconds" to TWA_SESSION_BURST_DELAYS_SECONDS.joinToString(","),
        ),
      )
    }

    fun scheduleFocusWaitReminder(context: Context, appWidgetId: Int, waitMinutes: Int) {
      val normalizedWait = waitMinutes.coerceAtLeast(1)
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
        .setInitialDelay(normalizedWait.toLong(), TimeUnit.MINUTES)
        .setInputData(
          Data.Builder()
            .putString("reason", "focus-wait-reminder-${normalizedWait}m")
            .build(),
        )
        .build()

      WorkManager.getInstance(context).enqueueUniqueWork(
        "$FOCUS_WAIT_REMINDER_WORK_PREFIX-$appWidgetId",
        ExistingWorkPolicy.REPLACE,
        request,
      )
      NanoflowWidgetTelemetry.info(
        "widget_focus_wait_reminder_scheduled",
        mapOf(
          "appWidgetId" to appWidgetId,
          "waitMinutes" to normalizedWait,
        ),
      )
    }

    fun scheduleGateReadCooldownRefresh(
      context: Context,
      appWidgetId: Int,
      delayMs: Long = GATE_READ_REAPPEAR_COOLDOWN_MS,
    ) {
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
        .setInitialDelay(delayMs.coerceAtLeast(0L), TimeUnit.MILLISECONDS)
        .setInputData(
          Data.Builder()
            .putString("reason", "gate-read-cooldown")
            .build(),
        )
        .build()

      WorkManager.getInstance(context).enqueueUniqueWork(
        "$GATE_READ_COOLDOWN_REFRESH_WORK_PREFIX-$appWidgetId",
        ExistingWorkPolicy.REPLACE,
        request,
      )
      NanoflowWidgetTelemetry.info(
        "widget_gate_read_cooldown_refresh_scheduled",
        mapOf(
          "appWidgetId" to appWidgetId,
          "delayMs" to delayMs.coerceAtLeast(0L),
        ),
      )
    }

    fun syncPeriodicRefresh(context: Context, enabled: Boolean) {
      NanoflowWidgetTelemetry.info(
        "widget_periodic_refresh_synced",
        mapOf("enabled" to enabled),
      )
      val workManager = WorkManager.getInstance(context)
      if (!enabled) {
        workManager.cancelUniqueWork(UNIQUE_PERIODIC_WORK_NAME)
        return
      }

      val request = PeriodicWorkRequestBuilder<NanoflowWidgetRefreshWorker>(15, TimeUnit.MINUTES)
        .setInputData(Data.Builder().putString("reason", "periodic-refresh").build())
        .build()

      workManager.enqueueUniquePeriodicWork(
        UNIQUE_PERIODIC_WORK_NAME,
        ExistingPeriodicWorkPolicy.KEEP,
        request,
      )
    }
  }
}
