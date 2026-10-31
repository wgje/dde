package app.nanoflow.host

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetGateNavigationCoordinatorTest {
  @Test
  fun `same widget equal deltas persist FIFO without coalescing`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val secondStarted = CompletableDeferred<Unit>()
    val persisted = Channel<String>(Channel.UNLIMITED)
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = coordinator<String>()

    coordinator.submit(
      appWidgetId = 7,
      delta = 1,
      persist = { delta ->
        firstStarted.complete(Unit)
        releaseFirst.await()
        "first:$delta".also { persisted.trySend(it).getOrThrow() }
      },
      telemetry = {},
      render = {},
      finish = { finishes.trySend("first").getOrThrow() },
    )
    firstStarted.await()

    coordinator.submit(
      appWidgetId = 7,
      delta = 1,
      persist = { delta ->
        secondStarted.complete(Unit)
        "second:$delta".also { persisted.trySend(it).getOrThrow() }
      },
      telemetry = {},
      render = {},
      finish = { finishes.trySend("second").getOrThrow() },
    )
    yield()

    assertFalse(secondStarted.isCompleted)
    releaseFirst.complete(Unit)
    withTimeout(2_000) { secondStarted.await() }
    assertEquals(listOf("first:1", "second:1"), listOf(persisted.receive(), persisted.receive()))
    assertEquals(listOf("first", "second"), listOf(finishes.receive(), finishes.receive()))
  }

  @Test
  fun `newer generation suppresses only stale render`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val persisted = Channel<String>(Channel.UNLIMITED)
    val telemetry = Channel<String>(Channel.UNLIMITED)
    val renders = Channel<String>(Channel.UNLIMITED)
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = coordinator<String>()

    coordinator.submit(
      appWidgetId = 4,
      delta = -1,
      persist = { delta ->
        firstStarted.complete(Unit)
        releaseFirst.await()
        "old:$delta".also { persisted.trySend(it).getOrThrow() }
      },
      telemetry = { telemetry.trySend(it).getOrThrow() },
      render = { renders.trySend(it).getOrThrow() },
      finish = { finishes.trySend("old").getOrThrow() },
    )
    firstStarted.await()
    coordinator.submit(
      appWidgetId = 4,
      delta = 1,
      persist = { delta -> "new:$delta".also { persisted.trySend(it).getOrThrow() } },
      telemetry = { telemetry.trySend(it).getOrThrow() },
      render = { renders.trySend(it).getOrThrow() },
      finish = { finishes.trySend("new").getOrThrow() },
    )

    releaseFirst.complete(Unit)

    assertEquals(listOf("old:-1", "new:1"), listOf(persisted.receive(), persisted.receive()))
    assertEquals(listOf("old:-1", "new:1"), listOf(telemetry.receive(), telemetry.receive()))
    assertEquals("new:1", renders.receive())
    assertEquals(listOf("old", "new"), listOf(finishes.receive(), finishes.receive()))
    yield()
    assertTrue(renders.tryReceive().isFailure)
  }

  @Test
  fun `different widgets progress concurrently`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val secondFinished = CompletableDeferred<Unit>()
    val coordinator = coordinator<Unit>()

    coordinator.submit(
      appWidgetId = 1,
      delta = 1,
      persist = {
        firstStarted.complete(Unit)
        releaseFirst.await()
      },
      telemetry = {},
      render = {},
      finish = {},
    )
    firstStarted.await()
    coordinator.submit(
      appWidgetId = 2,
      delta = 1,
      persist = {},
      telemetry = {},
      render = {},
      finish = { secondFinished.complete(Unit) },
    )

    withTimeout(2_000) { secondFinished.await() }
    releaseFirst.complete(Unit)
    Unit
  }

  @Test
  fun `submission returns while current render is blocked outside widget lock`() = runBlocking {
    val renderStarted = CompletableDeferred<Unit>()
    val releaseRender = CountDownLatch(1)
    val secondSubmitReturned = CompletableDeferred<Unit>()
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = NanoflowWidgetGateNavigationCoordinator<String>(
      scope = this,
      processingContext = Dispatchers.Default,
    )

    coordinator.submit(
      appWidgetId = 8,
      delta = 1,
      persist = { "first" },
      telemetry = {},
      render = {
        renderStarted.complete(Unit)
        assertTrue(releaseRender.await(2, TimeUnit.SECONDS))
      },
      finish = { finishes.trySend("first").getOrThrow() },
    )
    renderStarted.await()

    val submitJob = launch(Dispatchers.Default) {
      coordinator.submit(
        appWidgetId = 8,
        delta = 1,
        persist = { "second" },
        telemetry = {},
        render = {},
        finish = { finishes.trySend("second").getOrThrow() },
      )
      secondSubmitReturned.complete(Unit)
    }

    withTimeout(2_000) { secondSubmitReturned.await() }
    releaseRender.countDown()
    submitJob.join()
    assertEquals(listOf("first", "second"), listOf(finishes.receive(), finishes.receive()))
  }

  @Test
  fun `all failure boundaries finish once and later navigation continues`() = runBlocking {
    val reports = AtomicInteger()
    val firstFinish = AtomicInteger()
    val secondFinish = AtomicInteger()
    val thirdFinish = AtomicInteger()
    val fourthFinish = AtomicInteger()
    val firstFinishAttempted = CompletableDeferred<Unit>()
    val telemetryFailureStillRendered = CompletableDeferred<Unit>()
    val secondFinished = CompletableDeferred<Unit>()
    val thirdFinished = CompletableDeferred<Unit>()
    val finalRendered = CompletableDeferred<Unit>()
    val coordinator = coordinator<String>(reportFailure = {
      reports.incrementAndGet()
      error("reporter failed")
    })

    coordinator.submit(
      appWidgetId = 9,
      delta = 1,
      persist = { error("persistence failed") },
      telemetry = { error("failed persistence must not emit telemetry") },
      render = { error("failed persistence must not render") },
      finish = {
        firstFinish.incrementAndGet()
        firstFinishAttempted.complete(Unit)
        error("finish failed")
      },
    )
    firstFinishAttempted.await()
    coordinator.submit(
      appWidgetId = 9,
      delta = 1,
      persist = { "telemetry-failure" },
      telemetry = { error("telemetry failed") },
      render = { telemetryFailureStillRendered.complete(Unit) },
      finish = {
        secondFinish.incrementAndGet()
        secondFinished.complete(Unit)
      },
    )
    telemetryFailureStillRendered.await()
    secondFinished.await()
    coordinator.submit(
      appWidgetId = 9,
      delta = 1,
      persist = { "render-failure" },
      telemetry = {},
      render = { error("render failed") },
      finish = {
        thirdFinish.incrementAndGet()
        thirdFinished.complete(Unit)
      },
    )
    thirdFinished.await()
    coordinator.submit(
      appWidgetId = 9,
      delta = 1,
      persist = { "recovered" },
      telemetry = {},
      render = { finalRendered.complete(Unit) },
      finish = { fourthFinish.incrementAndGet() },
    )

    withTimeout(2_000) {
      finalRendered.await()
      while (fourthFinish.get() == 0) yield()
    }
    assertTrue(reports.get() >= 4)
    assertEquals(1, firstFinish.get())
    assertEquals(1, secondFinish.get())
    assertEquals(1, thirdFinish.get())
    assertEquals(1, fourthFinish.get())
  }

  private fun <Result> CoroutineScope.coordinator(
    reportFailure: (Throwable) -> Unit = {},
  ): NanoflowWidgetGateNavigationCoordinator<Result> {
    return NanoflowWidgetGateNavigationCoordinator(
      scope = this,
      processingContext = EmptyCoroutineContext,
      reportFailure = reportFailure,
    )
  }
}
