package app.nanoflow.host

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetRefreshWorkerContractTest {
  private val worker = readSource("NanoflowWidgetRefreshWorker.kt")
  private val receiver = readSource("NanoflowWidgetReceiver.kt")
  private val store = readSource("NanoflowWidgetStore.kt")
  private val repository = readSource("NanoflowWidgetRepository.kt")
  private val gateHandler = readSource("NanoflowWidgetGateActionHandler.kt")
  private val focusCoordinator = readSource("NanoflowWidgetFocusMutationCoordinator.kt")

  @Test
  fun `store owns immutable authoritative tickets and mutex commit`() {
    assertTrue(repository.contains("data class NanoflowWidgetAuthoritativeRefreshTicket"))
    assertTrue(store.contains("NanoflowWidgetAuthoritativeRefreshAttemptRegistry"))
    val begin = store.substringAfter("suspend fun beginAuthoritativeRefresh")
      .substringBefore("suspend fun commitAuthoritativeRefresh")
    val commit = store.substringAfter("suspend fun commitAuthoritativeRefresh")
      .substringBefore("suspend fun persistSignatureIfCurrent")
    assertTrue(begin.contains("bindingMutex.withLock"))
    assertTrue(commit.contains("bindingMutex.withLock"))
    assertTrue(commit.contains("isCurrent"))
    assertTrue(commit.contains("bindingEpoch"))
    assertTrue(commit.contains("bindingGeneration"))
  }

  @Test
  fun `bootstrap phase A invalidates attempts and owner state before secure commit`() {
    val bootstrap = blockAfter(store, "suspend fun applyBootstrapPayload")
    val invalidate = bootstrap.indexOf("invalidateWidgetBinding()")
    val clearOwnerState = bootstrap.indexOf("authoritativeState.clearMismatched")
    val secureCommit = bootstrap.indexOf("secureTransitionFence.commit")
    assertTrue(invalidate >= 0)
    assertTrue(clearOwnerState > invalidate)
    assertTrue(secureCommit > clearOwnerState)
    assertTrue(bootstrap.contains("NanoflowWidgetFocusHintPreferences.clearAll"))
  }

  @Test
  fun `repository routes every response effect through ticket commit`() {
    val refresh = blockAfter(repository, "suspend fun refreshSummary")
    assertTrue(refresh.contains("beginAuthoritativeRefresh"))
    assertTrue(refresh.contains("commitAuthoritativeRefresh"))
    assertFalse(refresh.contains("store.saveSummary("))
    assertFalse(refresh.contains("store.clearBindingState("))
    assertFalse(refresh.contains("store.clearWidgetBindingContext("))
    assertFalse(refresh.contains("store.persistRateLimitBackoff("))
    assertFalse(refresh.contains("store.clearRateLimitBackoff("))
    assertTrue(refresh.contains("publishAuthoritativeRefreshIfCurrent"))
    val publication = blockAfter(repository, "private fun publishRefreshSummaryTelemetry")
    listOf(
      "summary-parse-failed",
      "widget_token_revoked",
      "widget_summary_backoff_applied",
      "widget_summary_fetch_success",
      "widget_summary_fetch_failure",
      "widget_stale_render",
      "widget_untrusted_render",
    ).forEach { event -> assertTrue(publication.contains(event), event) }
    val acceptedPublication = refresh.substringAfterLast("publishAuthoritativeRefreshIfCurrent(committedTicket)")
    assertTrue(acceptedPublication.contains("hintProjection.publishReconciled?.invoke()"))
    assertTrue(acceptedPublication.contains("mutationProjection.publishReconciled?.invoke()"))
    assertTrue(acceptedPublication.contains("publishRefreshSummaryTelemetry"))
  }

  @Test
  fun `effectful render normalization is committed before authoritative model publication`() {
    assertTrue(repository.contains("buildAuthoritativeRenderModel"))
    assertTrue(repository.contains("commitAuthoritativeRenderPreparation"))
    val render = blockAfter(receiver, "suspend fun renderAndApplyWidget")
    assertTrue(render.contains("buildAuthoritativeRenderModel"))
    assertTrue(render.indexOf("buildAuthoritativeRenderModel") < render.indexOf("NanoflowWidgetRenderer.render"))
    assertFalse(render.contains("repository.buildRenderModel(appWidgetId)"))
  }

  @Test
  fun `all authoritative response callers propagate the exact committed ticket`() {
    val gateRemote = blockAfter(gateHandler, "private suspend fun submitRemoteAction")
    assertTrue(gateRemote.contains("onCommitted"))
    assertTrue(gateRemote.contains("renderCurrentWidget(appContext, repository, appWidgetId, it)"))
    assertTrue(gateRemote.contains("committedTicket?.let"))
    assertTrue(blockAfter(gateHandler, "private suspend fun renderCurrentWidget").contains("afterApply"))

    listOf("executeComplete", "executeWait", "executeSelectTask").forEach { method ->
      val block = blockAfter(focusCoordinator, "private suspend fun $method")
      assertTrue(block.contains("refreshAfterNonOptimisticSuccess"), method)
    }
    val focusRefresh = focusCoordinator.substringAfter("private suspend fun refreshAfterNonOptimisticSuccess")
      .substringBefore("private suspend fun rollbackFocus")
    assertTrue(focusRefresh.contains("onCommitted"))
    assertTrue(focusRefresh.contains("authoritativeTicket = committedTicket"))
    assertTrue(focusRefresh.contains("committedTicket?.let"))
  }

  @Test
  fun `optimistic persistence and render reuse original provenance fences`() {
    assertFalse(repository.contains("store.saveSummary("))
    assertTrue(repository.contains("sealed interface WidgetOptimisticResult"))
    listOf("Committed", "CurrentNoSnapshot", "RejectedStale").forEach {
      assertTrue(repository.contains(it), it)
    }
    listOf(
      "applyOptimisticBlackBoxAction",
      "applyOptimisticFocusPromotion",
      "applyOptimisticFocusCompletion",
      "applyOptimisticFocusWait",
    ).forEach { method ->
      val declaration = repository.substringAfter("suspend fun $method")
      val block = blockAfter(repository, "suspend fun $method")
      assertTrue(declaration.take(300).contains("readOptimisticSummary"), method)
      assertTrue(block.contains("commitOptimisticSummary"), method)
      assertTrue(declaration.take(200).contains("WidgetOptimisticResult"), method)
    }
    listOf("rollbackOptimisticBlackBoxAction", "rollbackOptimisticFocusPromotion").forEach { method ->
      val declaration = repository.substringAfter("suspend fun $method").take(800)
      assertTrue(declaration.contains("commitOptimisticSummary"), method)
      assertTrue(declaration.contains("snapshot.source"), method)
    }

    val gate = blockAfter(gateHandler, "suspend fun handle")
    assertTrue(gate.contains("optimisticSnapshot.source.ticket"))
    val focusRender = blockAfter(focusCoordinator, "private suspend fun renderCurrentWidget")
    assertTrue(focusRender.contains("authoritativeTicket = authoritativeTicket"))
    assertTrue(focusRender.contains("commitIfCurrent = generation::commitIfCurrent"))
    assertTrue(focusCoordinator.contains("authoritativeTicket = snapshot.source.ticket"))
    listOf("executeComplete", "executeWait").forEach { method ->
      val block = blockAfter(focusCoordinator, "private suspend fun $method")
      assertTrue(block.contains("renderOptimisticWidget"), method)
    }
    assertTrue(blockAfter(focusCoordinator, "private suspend fun executeSelectTask").contains("renderSelectSafely"))
    val rollback = focusCoordinator.substringAfter("private suspend fun rollbackFocus")
      .substringBefore("private suspend fun renderSelectSafely")
    assertTrue(rollback.contains("renderOptimisticWidget"))
  }

  @Test
  fun `rejected optimistic save is terminal while current no snapshot keeps fallback`() {
    val gate = blockAfter(gateHandler, "suspend fun handle")
    val gateReject = gate.indexOf("WidgetOptimisticResult.RejectedStale -> return")
    assertTrue(gateReject >= 0)
    assertTrue(gateReject < gate.indexOf("submitRemoteAction"))
    assertTrue(gate.contains("WidgetOptimisticResult.CurrentNoSnapshot -> null"))

    listOf("executeComplete", "executeWait", "executeSelectTask").forEach { method ->
      val focus = blockAfter(focusCoordinator, "private suspend fun $method")
      val reject = focus.indexOf("WidgetOptimisticResult.RejectedStale")
      assertTrue(reject >= 0, method)
      assertTrue(reject < focus.indexOf("completeFrontFocusTask").takeIf { it >= 0 }
        ?: focus.indexOf("suspendFrontFocusTask").takeIf { it >= 0 }
        ?: focus.indexOf("promoteFocusSecondaryTask"), method)
      assertTrue(focus.contains("return noPublication"), method)
      assertTrue(focus.contains("WidgetOptimisticResult.CurrentNoSnapshot"), method)
    }
  }

  @Test
  fun `rejected optimistic rollback is terminal before Gate and Focus publication`() {
    val gateFailure = blockAfter(gateHandler, "private suspend fun submitRemoteAction")
    val gateRejected = gateFailure.indexOf("rollbackResult === WidgetOptimisticResult.RejectedStale")
    assertTrue(gateRejected >= 0)
    assertTrue(gateRejected < gateFailure.indexOf("Toast.makeText"))
    assertTrue(gateRejected < gateFailure.indexOf("NanoflowWidgetRefreshWorker.enqueue", gateRejected))

    listOf("executeComplete", "executeWait", "executeSelectTask").forEach { method ->
      val failure = blockAfter(focusCoordinator, "private suspend fun $method")
      assertTrue(failure.contains("return noPublication"), method)
      assertTrue(failure.contains("rollbackFocus"), method)
    }
    val postPersistence = blockAfter(focusCoordinator, "private fun runPostPersistence")
    assertTrue(postPersistence.contains("delivery !is NanoflowWidgetFocusMutationDelivery.Refresh"))
    val delivery = blockAfter(focusCoordinator, "private fun deliverCurrent")
    assertTrue(delivery.contains("NanoflowWidgetFocusMutationDelivery.NoPublication -> Unit"))
  }

  @Test
  fun `binding rebind and clear invalidate Focus generation before suspension`() {
    listOf("applyBootstrapPayload", "clearBindingState", "clearAllWidgetState").forEach { method ->
      val transition = blockAfter(store, "suspend fun $method")
      val invalidate = transition.indexOf("invalidateWidgetBinding()")
      assertTrue(invalidate in 0 until transition.indexOf("bindingMutex.withLock"), method)
    }
    val lockedClear = blockAfter(store, "private suspend fun clearBindingStateLocked")
    assertTrue(lockedClear.trimStart().startsWith("authoritativeRefreshAttempts.invalidateWidgetBinding()"))
    assertTrue(focusCoordinator.contains("fun invalidateBinding()"))
    assertTrue(focusCoordinator.contains("bindingGeneration"))
    assertTrue(focusCoordinator.contains("isBindingCurrent"))
  }

  @Test
  fun `receiver registry is extracted and binding clear invalidates before suspension`() {
    assertFalse(receiver.contains("class NanoflowWidgetAuthoritativeRefreshAttemptRegistry"))
    assertTrue(worker.contains("class NanoflowWidgetAuthoritativeRefreshAttemptRegistry"))
    val clearBinding = blockAfter(store, "suspend fun clearBindingState")
    assertTrue(clearBinding.indexOf("invalidateWidgetBinding()") in 0 until clearBinding.indexOf("bindingMutex.withLock"))
    val clearAll = blockAfter(store, "suspend fun clearAllWidgetState")
    assertTrue(clearAll.indexOf("invalidateWidgetBinding()") in 0 until clearAll.indexOf("bindingMutex.withLock"))
    listOf("clearWidgetState", "clearWidgetBindingContext").forEach { method ->
      val clearWidget = blockAfter(store, "suspend fun $method")
      assertTrue(clearWidget.indexOf("invalidateWidget") in 0 until clearWidget.indexOf("bindingMutex.withLock"), method)
    }
  }

  @Test
  fun `worker propagates cancellation and correctness is independent of REPLACE`() {
    assertTrue(worker.contains("NanoflowWidgetRefreshOrchestrator"))
    assertTrue(worker.contains("rethrowCancellation"))
    assertTrue(worker.contains("ExistingWorkPolicy.REPLACE"))
    assertFalse(worker.contains("processEpoch\""))
    val inputData = blockAfter(worker, "fun enqueue(context: Context, reason: String)")
    assertFalse(inputData.contains("processEpoch"))
    assertFalse(inputData.contains("bindingGeneration"))
    assertFalse(inputData.contains("deviceId"))
  }

  @Test
  fun `refresh success telemetry is emitted only inside the exact current ticket fence`() {
    val refresh = blockAfter(worker, "refresh =")
    val render = blockAfter(worker, "render =")

    assertFalse(refresh.contains(".also"))
    assertFalse(refresh.contains("widget_refresh_succeeded"))
    assertTrue(render.contains("commitIfCurrent"))
    assertTrue(render.contains("widget_refresh_succeeded"))
    assertTrue(render.contains("appWidgetId"))
  }

  @Test
  fun `receiver applies lists and signatures only through the exact ticket`() {
    assertFalse(receiver.contains("runBlocking"))
    assertFalse(receiver.contains("fun refreshAllWidgets"))
    val render = blockAfter(receiver, "suspend fun renderAndApplyWidget")
    assertTrue(render.contains("commitIfCurrent"))
    assertTrue(render.contains("commitPublication"))
    assertTrue(render.contains("ticket.commitIfCurrent"))
    assertTrue(render.contains("generationAccepted = commitIfCurrent"))
    assertTrue(render.contains("afterApply()"))
    assertTrue(render.contains("persistSignatureIfCurrent"))
    assertFalse(render.contains("store.persistLastAppliedLayoutSignature(appWidgetId, newSignature)"))
  }

  @Test
  fun `exact-nine files retain approved caps`() {
    assertTrue(worker.trimEnd().lineSequence().count() <= 412)
    assertTrue(receiver.trimEnd().lineSequence().count() <= 750)
    assertTrue(store.trimEnd().lineSequence().count() <= 779)
    assertTrue(repository.trimEnd().lineSequence().count() <= 2_703)
    assertTrue(gateHandler.trimEnd().lineSequence().count() <= 320)
    assertTrue(focusCoordinator.trimEnd().lineSequence().count() <= 650)
    assertTrue(readSource("NanoflowWidgetRefreshWorkerTest.kt").lineSequence().count() < 650)
    assertTrue(readSource("NanoflowWidgetRefreshWorkerContractTest.kt").lineSequence().count() <= 360)
    assertTrue(readSource("NanoflowWidgetFocusMutationCoordinatorTest.kt").lineSequence().count() <= 500)
  }

  private fun blockAfter(source: String, marker: String): String {
    val markerIndex = source.indexOf(marker)
    check(markerIndex >= 0) { "Missing marker: $marker" }
    val openBrace = source.indexOf('{', markerIndex)
    check(openBrace >= 0) { "Missing block after: $marker" }
    var depth = 0
    for (index in openBrace until source.length) {
      when (source[index]) {
        '{' -> depth += 1
        '}' -> if (--depth == 0) return source.substring(openBrace + 1, index)
      }
    }
    error("Unterminated block after: $marker")
  }

  private fun readSource(fileName: String): String {
    val candidates = listOf(
      Path.of("src/main/java/app/nanoflow/host/$fileName"),
      Path.of("src/test/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("app/src/test/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/main/java/app/nanoflow/host/$fileName"),
      Path.of("android/app/src/test/java/app/nanoflow/host/$fileName"),
    )
    return candidates.firstOrNull(Files::exists)?.toFile()?.readText()
      ?: error("$fileName was not found")
  }
}
