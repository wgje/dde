package app.nanoflow.host

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast

class NanoflowWidgetBootstrapActivity : Activity() {
  private var bootstrapOwner: NanoflowWidgetBootstrapOwner? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    bootstrapOwner = NanoflowWidgetBootstrapProcessCoordinator.attach(
      applicationContext,
      ::handleBootstrapOutcome,
    )
    handleBootstrapIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleBootstrapIntent(intent)
  }

  override fun onDestroy() {
    bootstrapOwner?.let { owner ->
      NanoflowWidgetBootstrapProcessCoordinator.detach(owner)
    }
    bootstrapOwner = null
    super.onDestroy()
  }

  private fun handleBootstrapIntent(intent: Intent?) {
    val owner = bootstrapOwner ?: return
    NanoflowWidgetBootstrapProcessCoordinator.submit(owner, intent?.data)
  }

  private fun handleBootstrapOutcome(outcome: NanoflowWidgetBootstrapOutcome) {
    when (outcome) {
      is NanoflowWidgetBootstrapOutcome.Completed -> {
        if (outcome.accepted) {
          handleAcceptedBootstrap()
        } else {
          showBootstrapToast(R.string.nanoflow_widget_bootstrap_failed_toast)
          finish()
        }
      }
      is NanoflowWidgetBootstrapOutcome.Failed -> {
        NanoflowWidgetTelemetry.warn(
          event = "widget_bootstrap_callback_delivery_failed",
          fields = mapOf(
            "generation" to outcome.generation,
            "requestFingerprint" to outcome.fingerprint,
            "errorType" to outcome.exceptionType,
          ),
        )
        showBootstrapToast(R.string.nanoflow_widget_bootstrap_failed_toast)
        finish()
      }
    }
  }

  private fun handleAcceptedBootstrap() {
    completeAcceptedBootstrap(
      syncPeriodicRefresh = {
        NanoflowWidgetRefreshWorker.syncPeriodicRefresh(
          applicationContext,
          enabled = NanoflowWidgetReceiver.hasInstalledWidgets(applicationContext),
        )
      },
      enqueueFollowUp = {
        NanoflowWidgetRefreshWorker.enqueue(
          applicationContext,
          reason = "bootstrap-callback-followup",
        )
        NanoflowWidgetTelemetry.info("widget_bootstrap_followup_submitted")
      },
      launchHome = ::returnToWidgetHostSurface,
      finish = ::finish,
      reportFailure = ::reportBootstrapCompletionFailure,
    )
  }

  private fun showBootstrapToast(messageResId: Int) {
    Toast.makeText(applicationContext, getString(messageResId), Toast.LENGTH_SHORT).show()
  }

  private fun reportBootstrapCompletionFailure(step: String, error: Throwable) {
    NanoflowWidgetTelemetry.warn(
      event = "widget_bootstrap_completion_step_failed",
      fields = mapOf(
        "step" to step,
        "errorClass" to (error::class.simpleName ?: "unknown"),
      ),
      error = error,
    )
  }

  private fun returnToWidgetHostSurface() {
    val homeIntent = Intent(Intent.ACTION_MAIN).apply {
      addCategory(Intent.CATEGORY_HOME)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK
    }

    startActivity(homeIntent)
    NanoflowWidgetTelemetry.info("widget_bootstrap_return_home_started")
  }
}

internal fun completeAcceptedBootstrap(
  syncPeriodicRefresh: () -> Unit,
  enqueueFollowUp: () -> Unit,
  launchHome: () -> Unit,
  finish: () -> Unit,
  reportFailure: (String, Throwable) -> Unit,
) {
  try {
    attemptBootstrapCompletionStep(
      step = "periodic-refresh-sync",
      reportFailure = reportFailure,
      action = syncPeriodicRefresh,
    )
    attemptBootstrapCompletionStep(
      step = "follow-up-enqueue",
      reportFailure = reportFailure,
      action = enqueueFollowUp,
    )
    attemptBootstrapCompletionStep(
      step = "home-launch",
      reportFailure = reportFailure,
      action = launchHome,
    )
  } finally {
    try {
      finish()
    } catch (error: Throwable) {
      runCatching { reportFailure("finish", error) }
    }
  }
}

private inline fun attemptBootstrapCompletionStep(
  step: String,
  reportFailure: (String, Throwable) -> Unit,
  action: () -> Unit,
) {
  try {
    action()
  } catch (error: Throwable) {
    runCatching { reportFailure(step, error) }
  }
}
