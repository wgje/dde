package app.nanoflow.host

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.tasks.await
import java.util.concurrent.TimeUnit

class NanoflowWidgetRefreshWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
  override suspend fun doWork(): Result {
    val repository = NanoflowWidgetRepository(applicationContext)
    val reason = inputData.getString("reason") ?: "unknown"
    NanoflowWidgetTelemetry.info("widget_refresh_started", mapOf("reason" to reason))

    // 2026-04-21 FCM 收敛补丁：每次 refresh 时机会性地确保本地 pendingPushToken 有值。
    // 理由：`FirebaseMessagingService.onNewToken` 只在 token 发生变化时回调，首装 token
    // 可能在 FCM 自动注册瞬间回调但 Service 还没起来就被丢；或者 token 因 Play 服务重置
    // 丢失后永远补不上。通过 FirebaseMessaging.getInstance().token 显式拉取可覆盖这些
    // edge case —— 调用本身幂等，拉到已有 token 只写一次 DataStore。guard 在 FCM 未就绪
    // 构建（无 google-services.json）时完全跳过，不引入运行时依赖。
    ensureFcmTokenPersisted(applicationContext)

    return runCatching {
      repository.refreshInstalledWidgets()
      NanoflowWidgetTelemetry.info("widget_refresh_succeeded", mapOf("reason" to reason))
      Result.success()
    }.getOrElse { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_refresh_failed",
        mapOf("reason" to reason),
        error,
      )
      Result.retry()
    }.also {
      // 通知所有已安装 widget 重新渲染（原生 RemoteViews 路径）。
      NanoflowWidgetReceiver.refreshAllWidgets(applicationContext)
    }
  }

  private suspend fun ensureFcmTokenPersisted(context: Context) {
    if (!BuildConfig.NANOFLOW_FCM_ENABLED) {
      // 未配置 google-services.json 的构建：跳过，避免 FirebaseApp 未初始化时抛异常。
      return
    }
    try {
      val token = com.google.firebase.messaging.FirebaseMessaging.getInstance()
        .token
        .await()
      if (!token.isNullOrBlank()) {
        NanoflowWidgetRepository(context).rememberPushToken(token)
        NanoflowWidgetTelemetry.info(
          "widget_push_token_ensured",
          mapOf("tokenLength" to token.length, "source" to "worker-ensure"),
        )
      }
    } catch (error: Throwable) {
      NanoflowWidgetTelemetry.warn(
        "widget_push_token_ensure_failed",
        mapOf("errorClass" to (error::class.simpleName ?: "unknown")),
        error,
      )
    }
  }

  companion object {
    private const val UNIQUE_WORK_NAME = "nanoflow-widget-refresh"
    private const val UNIQUE_PERIODIC_WORK_NAME = "nanoflow-widget-refresh-periodic"

    fun enqueue(context: Context, reason: String) {
      NanoflowWidgetTelemetry.info("widget_refresh_enqueued", mapOf("reason" to reason))
      val request = OneTimeWorkRequestBuilder<NanoflowWidgetRefreshWorker>()
        .setInputData(Data.Builder().putString("reason", reason).build())
        .build()

      WorkManager.getInstance(context).enqueueUniqueWork(
        UNIQUE_WORK_NAME,
        ExistingWorkPolicy.REPLACE,
        request,
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
