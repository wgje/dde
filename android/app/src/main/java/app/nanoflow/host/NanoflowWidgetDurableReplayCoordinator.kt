package app.nanoflow.host

import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal object NanoflowWidgetDurableReplayCoordinator {
  private val replayMutex = Mutex()
  private val replayScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  suspend fun submitGateAction(context: Context, appWidgetId: Int, intent: Intent) = replayMutex.withLock {
    val appContext = context.applicationContext
    val store = NanoflowWidgetStore(appContext)
    val binding = store.readBinding()
    val gateAction = intent.getStringExtra(NanoflowWidgetActionFactory.EXTRA_GATE_ACTION)
    val entryId = resolveEntryId(appContext, store, appWidgetId, intent)
    val now = System.currentTimeMillis()
    val event = NanoflowWidgetReplayEvent(
      eventId = UUID.randomUUID().toString(),
      operationId = UUID.randomUUID().toString(),
      kind = "gate-action",
      appWidgetId = appWidgetId,
      gateAction = gateAction,
      entryId = entryId,
      ownerDeviceId = binding?.deviceId ?: "unbound",
      bindingGeneration = binding?.bindingGeneration ?: 0,
      createdAtMs = now,
      updatedAtMs = now,
    )
    store.persistDurableReplayEvent(event)
    replayPendingLocked(appContext, store, event.ownerDeviceId, event.bindingGeneration)
  }

  fun submitFocusAction(
    context: Context,
    appWidgetId: Int,
    focusAction: String?,
    taskId: String?,
    waitMinutes: Int,
    finish: () -> Unit,
  ) {
    replayScope.launch {
      try {
        replayMutex.withLock {
          val appContext = context.applicationContext
          val store = NanoflowWidgetStore(appContext)
          val binding = store.readBinding()
          val now = System.currentTimeMillis()
          val event = NanoflowWidgetReplayEvent(
            eventId = UUID.randomUUID().toString(),
            operationId = UUID.randomUUID().toString(),
            kind = "focus-action",
            appWidgetId = appWidgetId,
            focusAction = focusAction,
            taskId = taskId,
            waitMinutes = waitMinutes.coerceAtLeast(1),
            ownerDeviceId = binding?.deviceId ?: "unbound",
            bindingGeneration = binding?.bindingGeneration ?: 0,
            createdAtMs = now,
            updatedAtMs = now,
          )
          store.persistDurableReplayEvent(event)
          replayPendingLocked(appContext, store, event.ownerDeviceId, event.bindingGeneration, event.eventId, finish)
        }
      } catch (error: CancellationException) {
        runCatching(finish)
        throw error
      } catch (error: Throwable) {
        reportFailure(error)
        runCatching(finish)
      }
    }
  }

  fun submitFocusSelect(context: Context, appWidgetId: Int, targetIndex: Int, taskId: String, finish: () -> Unit) {
    replayScope.launch {
      try {
        replayMutex.withLock {
          val appContext = context.applicationContext
          val store = NanoflowWidgetStore(appContext)
          val binding = store.readBinding()
          val now = System.currentTimeMillis()
          val event = NanoflowWidgetReplayEvent(
            eventId = UUID.randomUUID().toString(), operationId = UUID.randomUUID().toString(), kind = "focus-action",
            appWidgetId = appWidgetId, focusAction = "promote-secondary", taskId = taskId,
            targetIndex = targetIndex, ownerDeviceId = binding?.deviceId ?: "unbound",
            bindingGeneration = binding?.bindingGeneration ?: 0, createdAtMs = now, updatedAtMs = now,
          )
          store.persistDurableReplayEvent(event)
          replayPendingLocked(appContext, store, event.ownerDeviceId, event.bindingGeneration, event.eventId, finish)
        }
      } catch (error: Throwable) { reportFailure(error); runCatching(finish) }
    }
  }

  suspend fun submitGateNavigation(context: Context, appWidgetId: Int, delta: Int, finish: () -> Unit) {
    val finished = AtomicBoolean(false)
    val finishOnce = {
      if (finished.compareAndSet(false, true)) {
        runCatching(finish)
      }
    }
    try {
      replayMutex.withLock {
        val appContext = context.applicationContext
        val store = NanoflowWidgetStore(appContext)
        val binding = store.readBinding()
        val now = System.currentTimeMillis()
        val event = NanoflowWidgetReplayEvent(
          eventId = UUID.randomUUID().toString(),
          operationId = UUID.randomUUID().toString(),
          kind = "gate-navigation",
          appWidgetId = appWidgetId,
          delta = delta,
          ownerDeviceId = binding?.deviceId ?: "unbound",
          bindingGeneration = binding?.bindingGeneration ?: 0,
          createdAtMs = now,
          updatedAtMs = now,
        )
        store.persistDurableReplayEvent(event)
        replayPendingLocked(appContext, store, event.ownerDeviceId, event.bindingGeneration, event.eventId, finishOnce)
      }
    } catch (error: CancellationException) {
      finishOnce()
      throw error
    } catch (error: Throwable) {
      reportFailure(error)
      finishOnce()
    }
  }

  private suspend fun replayPendingLocked(
    context: Context,
    store: NanoflowWidgetStore,
    ownerDeviceId: String,
    bindingGeneration: Int,
    finishEventId: String? = null,
    finish: () -> Unit = {},
  ) {
    var sawFinishEvent = false
    try {
      val events = store.takeoverDurableReplayEvents(ownerDeviceId, bindingGeneration)
      for (event in events) {
        if (event.eventId == finishEventId) sawFinishEvent = true
        when (event.kind) {
          "gate-navigation" -> NanoflowWidgetGateNavigationProcessCoordinator.replayEvent(
            context,
            event,
            store,
            if (event.eventId == finishEventId) finish else ({ }),
          )
          "gate-action" -> replayGateAction(context, store, event)
          "focus-action" -> replayFocusAction(context, store, event, if (event.eventId == finishEventId) finish else ({ }))
        }
      }
    } finally {
      if (finishEventId != null && !sawFinishEvent) finish()
    }
  }

  private suspend fun replayGateAction(context: Context, store: NanoflowWidgetStore, event: NanoflowWidgetReplayEvent) {
    val claimed = store.claimDurableReplayEvent(event) ?: return
    val entryId = claimed.entryId?.takeIf { it.isNotBlank() }
    val intent = Intent(context, NanoflowWidgetReceiver::class.java).apply {
      action = NanoflowWidgetReceiver.ACTION_CLICK_ITEM
      putExtra(NanoflowWidgetReceiver.EXTRA_APP_WIDGET_ID, claimed.appWidgetId)
      putExtra(NanoflowWidgetReceiver.EXTRA_ITEM_TYPE, NanoflowWidgetActionFactory.ITEM_TYPE_GATE_ACTION)
      putExtra(NanoflowWidgetActionFactory.EXTRA_GATE_ACTION, claimed.gateAction)
      putExtra(NanoflowWidgetReceiver.EXTRA_GATE_ENTRY_ID, entryId)
    }
    val validAction = claimed.gateAction == NanoflowWidgetActionFactory.GATE_ACTION_READ ||
      claimed.gateAction == NanoflowWidgetActionFactory.GATE_ACTION_COMPLETE
    if (!validAction || entryId == null) {
      runCatching { NanoflowWidgetGateActionHandler.handle(context, claimed.appWidgetId, intent, claimed) }
        .onFailure(::reportFailure)
      store.updateDurableReplayEvent(claimed.eventId, "rejected", "gate-action identity is incomplete")
      return
    }
    if (claimed.ownerDeviceId == "unbound" || claimed.bindingGeneration < 1) {
      store.updateDurableReplayEvent(claimed.eventId, "rejected", "widget binding was unavailable when the action was captured")
      return
    }
    val succeeded = try {
      NanoflowWidgetGateActionHandler.handle(context, claimed.appWidgetId, intent, claimed)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Throwable) {
      store.updateDurableReplayEvent(claimed.eventId, "failed", error.message ?: error.javaClass.simpleName)
      reportFailure(error)
      return
    }
    store.updateDurableReplayEvent(
      claimed.eventId,
      if (succeeded) "finished" else "failed",
      if (succeeded) null else "remote action was not confirmed",
    )
  }

  private suspend fun replayFocusAction(
    context: Context,
    store: NanoflowWidgetStore,
    event: NanoflowWidgetReplayEvent,
    finish: () -> Unit,
  ) {
    val claimed = store.claimDurableReplayEvent(event) ?: return
    val binding = store.readBinding()
    if (claimed.ownerDeviceId == "unbound" || claimed.bindingGeneration < 1 ||
      binding?.deviceId != claimed.ownerDeviceId || binding.bindingGeneration != claimed.bindingGeneration
    ) {
      store.updateDurableReplayEvent(claimed.eventId, "rejected", "focus binding changed before replay")
      runCatching(finish)
      return
    }
    val validAction = claimed.focusAction != null &&
      (claimed.focusAction == NanoflowWidgetActionFactory.FOCUS_ACTION_COMPLETE ||
        claimed.focusAction == NanoflowWidgetActionFactory.FOCUS_ACTION_WAIT_PRESET ||
        claimed.focusAction == NanoflowWidgetActionFactory.FOCUS_ACTION_WAIT ||
        claimed.focusAction == "promote-secondary")
    if (!validAction) {
      store.updateDurableReplayEvent(claimed.eventId, "rejected", "focus action identity is incomplete")
      runCatching(finish)
      return
    }
    NanoflowWidgetFocusMutationProcessCoordinator.submitFocusActionInternal(
      context = context,
      appWidgetId = claimed.appWidgetId,
      focusAction = claimed.focusAction,
      taskId = claimed.taskId,
      waitMinutes = claimed.waitMinutes ?: 1,
      targetIndex = claimed.targetIndex ?: 0,
      event = claimed,
      finish = finish,
    ) { confirmed ->
      replayScope.launch {
        store.updateDurableReplayEvent(
          claimed.eventId,
          if (confirmed) "finished" else "failed",
          if (confirmed) null else "focus action was not confirmed",
        )
      }
    }
  }

  private suspend fun resolveEntryId(
    context: Context,
    store: NanoflowWidgetStore,
    appWidgetId: Int,
    intent: Intent,
  ): String? = intent.getStringExtra(NanoflowWidgetReceiver.EXTRA_GATE_ENTRY_ID)?.takeIf { it.isNotBlank() }
    ?: runCatching {
      val summary = store.readSummary(appWidgetId) ?: return@runCatching null
      NanoflowWidgetRepository(context).resolveDisplayedGateEntries(appWidgetId, summary).firstOrNull()?.entryId
    }.getOrNull()?.takeIf { it.isNotBlank() }
    ?: store.readGateSelectedEntryId(appWidgetId)?.takeIf { it.isNotBlank() }

  private fun reportFailure(error: Throwable) {
    NanoflowWidgetTelemetry.warn(
      event = "widget_durable_replay_failed",
      fields = mapOf("errorType" to error.javaClass.simpleName),
      error = error,
    )
  }
}
