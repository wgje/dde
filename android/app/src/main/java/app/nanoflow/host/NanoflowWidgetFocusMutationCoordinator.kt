package app.nanoflow.host

import android.appwidget.AppWidgetManager
import android.content.Context
import android.widget.Toast
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

internal fun pendingFocusMutationActionKey(id: Int) = stringPreferencesKey("instance.$id.pendingFocusMutationAction")
internal fun pendingFocusMutationIssuedAtKey(id: Int) = longPreferencesKey("instance.$id.pendingFocusMutationIssuedAtMs")
private fun WidgetOptimisticResult<*>.isRejected() = this === WidgetOptimisticResult.RejectedStale

internal fun NanoflowWidgetAuthoritativeRefreshAttemptRegistry.invalidateWidgetBinding() {
  invalidateBinding()
  NanoflowWidgetFocusMutationProcessCoordinator.invalidateBinding()
}

internal class NanoflowWidgetFocusMutationGeneration internal constructor(
  private val current: () -> Boolean,
  private val commit: ((() -> Unit) -> Boolean),
) {
  fun isCurrent(): Boolean = current()

  fun commitIfCurrent(block: () -> Unit): Boolean = commit(block)
}

/** Process-local, per-widget FIFO. Persistence is never cancelled by a newer UI generation. */
internal class NanoflowWidgetFocusMutationCoordinator<Result>(
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
  private val processingContext: CoroutineContext = Dispatchers.IO,
  private val deliveryContext: CoroutineContext = Dispatchers.Main.immediate,
  private val reportFailure: (Throwable) -> Unit = {},
) {
  private val statesLock = Any()
  private val states = mutableMapOf<Int, WidgetState<Result>>()
  @Volatile private var bindingGeneration = 0L

  fun submit(
    appWidgetId: Int,
    mutationId: Any,
    mutate: suspend (NanoflowWidgetFocusMutationGeneration) -> Result,
    afterPersist: (Result) -> Unit = {},
    deliver: (Result) -> Unit,
    finish: () -> Unit,
  ): Long {
    var shouldStartWorker = false
    val (state, mutationBindingGeneration) = stateFor(appWidgetId)
    val generation: Long

    synchronized(state.lock) {
      generation = ++state.nextGeneration
      state.latestGeneration = generation

      val latest = state.pending.peekLast() ?: state.active
      if (latest?.mutationId == mutationId && latest.bindingGeneration == mutationBindingGeneration) {
        latest.generation = generation
        latest.afterPersist = afterPersist
        latest.deliver = deliver
        latest.completions += Completion(finish)
        return generation
      }

      state.pending.addLast(
        PendingMutation(
          mutationId = mutationId,
          generation = generation,
          bindingGeneration = mutationBindingGeneration,
          mutate = mutate,
          afterPersist = afterPersist,
          deliver = deliver,
          completions = mutableListOf(Completion(finish)),
        ),
      )
      if (!state.workerRunning) {
        state.workerRunning = true
        shouldStartWorker = true
      }
    }

    if (shouldStartWorker) {
      scope.launch { drain(state) }
    }
    return generation
  }

  fun invalidateBinding() {
    val currentStates = synchronized(statesLock) {
      bindingGeneration += 1L
      states.values.toList()
    }
    currentStates.forEach { state -> synchronized(state.lock) {} }
  }

  private fun stateFor(appWidgetId: Int): Pair<WidgetState<Result>, Long> = synchronized(statesLock) {
    states.getOrPut(appWidgetId) { WidgetState() } to bindingGeneration
  }

  private suspend fun drain(state: WidgetState<Result>) {
    while (true) {
      val current = synchronized(state.lock) {
        val next = state.pending.pollFirst()
        if (next == null) {
          state.active = null
          state.workerRunning = false
          null
        } else {
          state.active = next
          next
        }
      } ?: return

      val generation = NanoflowWidgetFocusMutationGeneration(
        current = {
          synchronized(state.lock) { isCurrentLocked(state, current) }
        },
        commit = { block ->
          synchronized(state.lock) {
            if (isCurrentLocked(state, current)) {
              block()
              true
            } else {
              false
            }
          }
        },
      )
      val processingResult = try {
        ProcessingResult.Success(withContext(processingContext) { current.mutate(generation) })
      } catch (error: Throwable) {
        reportSafely(error)
        ProcessingResult.Failed
      }

      synchronized(state.lock) {
        if (state.active === current) {
          state.active = null
        }
      }
      if (processingResult is ProcessingResult.Success) {
        try {
          synchronized(state.lock) {
            if (isBindingCurrent(current)) current.afterPersist(processingResult.value)
          }
        } catch (error: Throwable) {
          reportSafely(error)
        }
        try {
          withContext(deliveryContext) {
            synchronized(state.lock) {
              if (isCurrentLocked(state, current)) {
                current.deliver(processingResult.value)
              }
            }
          }
        } catch (error: Throwable) {
          reportSafely(error)
        }
      }

      val completions = synchronized(state.lock) { current.completions.toList() }
      completions.forEach { it.finish(::reportSafely) }
    }
  }

  private fun isCurrentLocked(
    state: WidgetState<Result>,
    mutation: PendingMutation<Result>,
  ): Boolean {
    return mutation.generation == state.latestGeneration && isBindingCurrent(mutation)
  }

  private fun isBindingCurrent(mutation: PendingMutation<Result>) = mutation.bindingGeneration == bindingGeneration

  private fun reportSafely(error: Throwable) {
    runCatching { reportFailure(error) }
  }

  private class WidgetState<Result> {
    val lock = Any()
    val pending = ArrayDeque<PendingMutation<Result>>()
    var active: PendingMutation<Result>? = null
    var workerRunning = false
    var nextGeneration = 0L
    var latestGeneration = 0L
  }

  private data class PendingMutation<Result>(
    val mutationId: Any,
    var generation: Long,
    val bindingGeneration: Long,
    val mutate: suspend (NanoflowWidgetFocusMutationGeneration) -> Result,
    var afterPersist: (Result) -> Unit,
    var deliver: (Result) -> Unit,
    val completions: MutableList<Completion>,
  )

  private class Completion(
    private val callback: () -> Unit,
  ) {
    private val finished = AtomicBoolean(false)

    fun finish(reportFailure: (Throwable) -> Unit) {
      if (!finished.compareAndSet(false, true)) return
      try {
        callback()
      } catch (error: Throwable) {
        reportFailure(error)
      }
    }
  }

  private sealed interface ProcessingResult<out Result> {
    data class Success<Result>(val value: Result) : ProcessingResult<Result>
    data object Failed : ProcessingResult<Nothing>
  }
}

private sealed interface NanoflowWidgetFocusMutationDelivery {
  data object NoPublication : NanoflowWidgetFocusMutationDelivery
  data class ToastOnly(val messageRes: Int) : NanoflowWidgetFocusMutationDelivery

  data class Refresh(
    val messageRes: Int,
    val reason: String,
    val waitReminderMinutes: Int? = null,
  ) : NanoflowWidgetFocusMutationDelivery

  data class OpenApp(val taskIndex: Int) : NanoflowWidgetFocusMutationDelivery
}

internal object NanoflowWidgetFocusMutationProcessCoordinator {
  private val noPublication = NanoflowWidgetFocusMutationDelivery.NoPublication
  private val coordinator = NanoflowWidgetFocusMutationCoordinator<NanoflowWidgetFocusMutationDelivery>(
    reportFailure = { error ->
      NanoflowWidgetTelemetry.warn(
        event = "widget_focus_mutation_unhandled",
        fields = mapOf("errorType" to (error::class.simpleName ?: "UnknownFocusMutationFailure")),
      )
    },
  )

  fun invalidateBinding() = coordinator.invalidateBinding()

  fun submitFocusAction(
    context: Context,
    appWidgetId: Int,
    focusAction: String?,
    taskId: String?,
    waitMinutes: Int,
    finish: () -> Unit,
  ) {
    val appContext = context.applicationContext
    coordinator.submit(
      appWidgetId = appWidgetId,
      mutationId = MutationIdentity("focus:$focusAction", taskId, waitMinutes),
      mutate = { generation ->
        executeFocusAction(
          context = appContext,
          appWidgetId = appWidgetId,
          focusAction = focusAction,
          taskId = taskId,
          waitMinutes = waitMinutes,
          generation = generation,
        )
      },
      afterPersist = { delivery -> runPostPersistence(appContext, appWidgetId, delivery) },
      deliver = { delivery -> deliverCurrent(appContext, appWidgetId, delivery) },
      finish = finish,
    )
  }

  fun submitSelectTask(
    context: Context,
    appWidgetId: Int,
    targetIndex: Int,
    taskId: String,
    finish: () -> Unit,
  ) {
    val appContext = context.applicationContext
    coordinator.submit(
      appWidgetId = appWidgetId,
      mutationId = MutationIdentity("select-task", taskId, targetIndex),
      mutate = { generation ->
        executeSelectTask(
          context = appContext,
          appWidgetId = appWidgetId,
          targetIndex = targetIndex,
          taskId = taskId,
          generation = generation,
        )
      },
      afterPersist = { delivery -> runPostPersistence(appContext, appWidgetId, delivery) },
      deliver = { delivery -> deliverCurrent(appContext, appWidgetId, delivery) },
      finish = finish,
    )
  }

  private suspend fun executeFocusAction(
    context: Context,
    appWidgetId: Int,
    focusAction: String?,
    taskId: String?,
    waitMinutes: Int,
    generation: NanoflowWidgetFocusMutationGeneration,
  ): NanoflowWidgetFocusMutationDelivery {
    val repository = NanoflowWidgetRepository(context)
    if (focusAction == NanoflowWidgetActionFactory.FOCUS_ACTION_WAIT) {
      NanoflowWidgetStore(context).persistFocusWaitMenuOpen(appWidgetId, true)
      renderCurrentWidget(context, repository, appWidgetId, generation, partialUpdate = true)
      return NanoflowWidgetFocusMutationDelivery.ToastOnly(R.string.nanoflow_widget_focus_wait_menu_toast)
    }

    val requiredTaskId = taskId ?: return NanoflowWidgetFocusMutationDelivery.ToastOnly(
      R.string.nanoflow_widget_focus_promote_failed_toast,
    )
    return when (focusAction) {
      NanoflowWidgetActionFactory.FOCUS_ACTION_COMPLETE -> executeComplete(
        context,
        repository,
        appWidgetId,
        requiredTaskId,
        generation,
      )
      NanoflowWidgetActionFactory.FOCUS_ACTION_WAIT_PRESET -> executeWait(
        context,
        repository,
        appWidgetId,
        requiredTaskId,
        waitMinutes.coerceAtLeast(1),
        generation,
      )
      else -> NanoflowWidgetFocusMutationDelivery.ToastOnly(R.string.nanoflow_widget_focus_promote_failed_toast)
    }
  }

  private suspend fun executeComplete(
    context: Context,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    taskId: String,
    generation: NanoflowWidgetFocusMutationGeneration,
  ): NanoflowWidgetFocusMutationDelivery {
    val optimisticResult = runCatching {
      repository.applyOptimisticFocusCompletion(appWidgetId, taskId)
    }.getOrDefault(WidgetOptimisticResult.CurrentNoSnapshot)
    val optimisticSnapshot = when (optimisticResult) {
      is WidgetOptimisticResult.Committed -> optimisticResult.snapshot.also {
        runCatching { renderOptimisticWidget(context, repository, appWidgetId, generation, it) } }
      WidgetOptimisticResult.CurrentNoSnapshot -> null
      WidgetOptimisticResult.RejectedStale -> return noPublication
    }

    val success = runRemote { repository.completeFrontFocusTask(appWidgetId, taskId) }
    if (success) {
      refreshAfterNonOptimisticSuccess(context, repository, appWidgetId, optimisticSnapshot, generation)
      return refreshDelivery(R.string.nanoflow_widget_focus_complete_toast, "focus-complete-front")
    }

    if (rollbackFocus(context, repository, appWidgetId, optimisticSnapshot, generation).isRejected()) return noPublication
    return refreshDelivery(R.string.nanoflow_widget_focus_promote_failed_toast, "focus-complete-front-retry")
  }

  private suspend fun executeWait(
    context: Context,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    taskId: String,
    waitMinutes: Int,
    generation: NanoflowWidgetFocusMutationGeneration,
  ): NanoflowWidgetFocusMutationDelivery {
    val optimisticResult = runCatching {
      repository.applyOptimisticFocusWait(appWidgetId, taskId, waitMinutes)
    }.getOrDefault(WidgetOptimisticResult.CurrentNoSnapshot)
    val optimisticSnapshot = when (optimisticResult) {
      is WidgetOptimisticResult.Committed -> optimisticResult.snapshot.also {
        runCatching { renderOptimisticWidget(context, repository, appWidgetId, generation, it) } }
      WidgetOptimisticResult.CurrentNoSnapshot -> null
      WidgetOptimisticResult.RejectedStale -> return noPublication
    }

    val success = runRemote {
      repository.suspendFrontFocusTask(appWidgetId, taskId, waitMinutes)
    }
    if (success) {
      refreshAfterNonOptimisticSuccess(context, repository, appWidgetId, optimisticSnapshot, generation)
      return refreshDelivery(R.string.nanoflow_widget_focus_wait_toast, "focus-wait-front", waitMinutes)
    }

    if (rollbackFocus(context, repository, appWidgetId, optimisticSnapshot, generation).isRejected()) return noPublication
    return refreshDelivery(R.string.nanoflow_widget_focus_promote_failed_toast, "focus-wait-front-retry")
  }

  private suspend fun executeSelectTask(
    context: Context,
    appWidgetId: Int,
    targetIndex: Int,
    taskId: String,
    generation: NanoflowWidgetFocusMutationGeneration,
  ): NanoflowWidgetFocusMutationDelivery {
    val repository = NanoflowWidgetRepository(context)
    val store = NanoflowWidgetStore(context)
    val currentFrontTaskId = runCatching {
      store.readSummary(appWidgetId)?.focus?.taskId?.takeIf { it.isNotBlank() }
    }.getOrNull()
    if (currentFrontTaskId == taskId) {
      NanoflowWidgetTelemetry.info(
        "widget_focus_promote_noop_already_front",
        mapOf("appWidgetId" to appWidgetId, "taskId" to NanoflowWidgetTelemetry.redactId(taskId)),
      )
      return NanoflowWidgetFocusMutationDelivery.ToastOnly(R.string.nanoflow_widget_focus_main_fixed_toast)
    }

    val canPromote = runCatching {
      repository.isVisibleCommandCenterTaskPromotable(appWidgetId, taskId)
    }.getOrDefault(false)
    if (!canPromote) {
      NanoflowWidgetTelemetry.info(
        "widget_focus_promote_fallback_open_app",
        mapOf(
          "appWidgetId" to appWidgetId,
          "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
          "taskIndex" to targetIndex,
        ),
      )
      return NanoflowWidgetFocusMutationDelivery.OpenApp(targetIndex)
    }

    val optimisticResult = runCatching {
      repository.applyOptimisticFocusPromotion(appWidgetId, taskId)
    }.onFailure { error ->
      NanoflowWidgetTelemetry.warn(
        "widget_focus_promote_optimistic_failed",
        mapOf("appWidgetId" to appWidgetId, "taskId" to NanoflowWidgetTelemetry.redactId(taskId)),
        error,
      )
    }.getOrDefault(WidgetOptimisticResult.CurrentNoSnapshot)
    val optimisticSnapshot = when (optimisticResult) {
      is WidgetOptimisticResult.Committed -> optimisticResult.snapshot.also {
        renderSelectSafely(context, repository, appWidgetId, taskId, "optimistic", generation, it) }
      WidgetOptimisticResult.CurrentNoSnapshot -> null
      WidgetOptimisticResult.RejectedStale -> return noPublication
    }

    val success = runRemote {
      repository.promoteFocusSecondaryTask(appWidgetId, taskId)
    }
    if (success) {
      refreshAfterNonOptimisticSuccess(
        context, repository, appWidgetId, optimisticSnapshot, generation,
        reportFailure = { error -> reportSelectRenderFailure(appWidgetId, taskId, "post-success", error) },
      )
      return refreshDelivery(R.string.nanoflow_widget_focus_promoted_toast, "focus-promote-secondary")
    }

    val rollbackResult = rollbackFocus(
      context, repository, appWidgetId, optimisticSnapshot, generation,
      reportFailure = { error ->
        NanoflowWidgetTelemetry.warn(
          "widget_focus_promote_rollback_failed",
          mapOf("appWidgetId" to appWidgetId, "taskId" to NanoflowWidgetTelemetry.redactId(taskId)),
          error,
        )
      },
    )
    if (rollbackResult.isRejected()) return noPublication
    return refreshDelivery(R.string.nanoflow_widget_focus_promote_failed_toast, "focus-promote-secondary-retry")
  }

  private fun refreshDelivery(
    messageRes: Int,
    reason: String,
    waitReminderMinutes: Int? = null,
  ) = NanoflowWidgetFocusMutationDelivery.Refresh(messageRes, reason, waitReminderMinutes)

  private suspend fun runRemote(submit: suspend () -> Boolean): Boolean = runCatching { submit() }.getOrElse { error ->
      error.rethrowFocusMutationCancellation()
      false
    }

  private suspend fun refreshAfterNonOptimisticSuccess(
    context: Context,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    snapshot: WidgetFocusOptimisticSnapshot?,
    generation: NanoflowWidgetFocusMutationGeneration,
    reportFailure: (Throwable) -> Unit = {},
  ) {
    if (snapshot != null) return
    runCatching {
      var committedTicket: NanoflowWidgetAuthoritativeRefreshTicket? = null
      repository.refreshSummary(appWidgetId, onCommitted = { committedTicket = it })
      committedTicket?.let {
        renderCurrentWidget(context, repository, appWidgetId, generation, authoritativeTicket = committedTicket)
      }
    }.onFailure { error ->
      error.rethrowFocusMutationCancellation()
      reportFailure(error)
    }
  }

  private suspend fun rollbackFocus(
    context: Context,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    snapshot: WidgetFocusOptimisticSnapshot?,
    generation: NanoflowWidgetFocusMutationGeneration,
    reportFailure: (Throwable) -> Unit = {},
  ): WidgetOptimisticResult<Unit> {
    if (snapshot == null) return WidgetOptimisticResult.Committed(Unit)
    return runCatching {
      repository.rollbackOptimisticFocusPromotion(appWidgetId, snapshot).also { result ->
        if (result is WidgetOptimisticResult.Committed)
          renderOptimisticWidget(context, repository, appWidgetId, generation, snapshot)
      }
    }.getOrElse { error ->
      reportFailure(error)
      WidgetOptimisticResult.Committed(Unit)
    }
  }

  private suspend fun renderSelectSafely(
    context: Context,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    taskId: String,
    phase: String,
    generation: NanoflowWidgetFocusMutationGeneration,
    snapshot: WidgetFocusOptimisticSnapshot,
  ) {
    runCatching {
      renderOptimisticWidget(context, repository, appWidgetId, generation, snapshot)
    }.onFailure { error ->
      reportSelectRenderFailure(appWidgetId, taskId, phase, error)
    }
  }

  private suspend fun renderOptimisticWidget(
    context: Context,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    generation: NanoflowWidgetFocusMutationGeneration,
    snapshot: WidgetFocusOptimisticSnapshot,
  ) = renderCurrentWidget(
    context, repository, appWidgetId, generation, authoritativeTicket = snapshot.source.ticket,
  )

  private fun reportSelectRenderFailure(
    appWidgetId: Int,
    taskId: String,
    phase: String,
    error: Throwable,
  ) {
    NanoflowWidgetTelemetry.warn(
      "widget_focus_promote_local_render_failed",
      mapOf(
        "appWidgetId" to appWidgetId,
        "taskId" to NanoflowWidgetTelemetry.redactId(taskId),
        "phase" to phase,
      ),
      error,
    )
  }

  private suspend fun renderCurrentWidget(
    context: Context,
    repository: NanoflowWidgetRepository,
    appWidgetId: Int,
    generation: NanoflowWidgetFocusMutationGeneration,
    partialUpdate: Boolean = false,
    authoritativeTicket: NanoflowWidgetAuthoritativeRefreshTicket? = null,
  ) {
    val appWidgetManager = AppWidgetManager.getInstance(context)
    NanoflowWidgetReceiver.renderAndApplyWidget(
      context = context,
      appWidgetManager = appWidgetManager,
      repository = repository,
      appWidgetId = appWidgetId,
      partialUpdate = partialUpdate,
      authoritativeTicket = authoritativeTicket,
      commitIfCurrent = generation::commitIfCurrent,
      afterApply = {
        NanoflowWidgetReceiver.notifyActionListsDataChanged(appWidgetManager, appWidgetId)
      },
    )
  }

  private fun Throwable.rethrowFocusMutationCancellation() {
    if (this is CancellationException) throw this
  }

  private fun runPostPersistence(
    context: Context,
    appWidgetId: Int,
    delivery: NanoflowWidgetFocusMutationDelivery,
  ) {
    if (delivery !is NanoflowWidgetFocusMutationDelivery.Refresh) return
    NanoflowWidgetRefreshWorker.enqueue(context, reason = delivery.reason)
    delivery.waitReminderMinutes?.let { minutes ->
      NanoflowWidgetRefreshWorker.scheduleFocusWaitReminder(context, appWidgetId, minutes)
    }
  }

  private fun deliverCurrent(
    context: Context,
    appWidgetId: Int,
    delivery: NanoflowWidgetFocusMutationDelivery,
  ) {
    when (delivery) {
      NanoflowWidgetFocusMutationDelivery.NoPublication -> Unit
      is NanoflowWidgetFocusMutationDelivery.ToastOnly -> showToast(context, delivery.messageRes)
      is NanoflowWidgetFocusMutationDelivery.Refresh -> showToast(context, delivery.messageRes)
      is NanoflowWidgetFocusMutationDelivery.OpenApp -> {
        NanoflowWidgetTelemetry.info(
          "widget_click_open_app",
          mapOf(
            "appWidgetId" to appWidgetId,
            "launchIntent" to NanoFlowLaunchIntent.OPEN_WORKSPACE.queryValue,
          ),
        )
        context.startActivity(
          NanoflowTwaLauncherActivity.intentForWidget(
            context = context,
            appWidgetId = appWidgetId,
            launchIntent = NanoFlowLaunchIntent.OPEN_WORKSPACE,
            taskIndex = delivery.taskIndex,
          ),
        )
      }
    }
  }

  private fun showToast(context: Context, messageRes: Int) {
    Toast.makeText(context, context.getString(messageRes), Toast.LENGTH_SHORT).show()
  }

  private data class MutationIdentity(
    val action: String,
    val taskId: String?,
    val value: Int,
  )
}
