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
import java.util.concurrent.TimeUnit

class NanoflowWidgetRefreshWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
  override suspend fun doWork(): Result {
    val repository = NanoflowWidgetRepository(applicationContext)
    val reason = inputData.getString("reason") ?: "unknown"
    NanoflowWidgetTelemetry.info("widget_refresh_started", mapOf("reason" to reason))
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
