package app.nanoflow.host

import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetFocusMutationCoordinatorTest {
  @Test
  fun `same widget mutations execute FIFO and submit returns immediately`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val secondStarted = CompletableDeferred<Unit>()
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = coordinator<String>()

    coordinator.submit(
      appWidgetId = 7,
      mutationId = "mutation-a",
      mutate = {
        firstStarted.complete(Unit)
        releaseFirst.await()
        "a"
      },
      deliver = {},
      finish = { finishes.trySend("a").getOrThrow() },
    )
    firstStarted.await()

    coordinator.submit(
      appWidgetId = 7,
      mutationId = "mutation-b",
      mutate = {
        secondStarted.complete(Unit)
        "b"
      },
      deliver = {},
      finish = { finishes.trySend("b").getOrThrow() },
    )
    yield()

    assertFalse(secondStarted.isCompleted)
    releaseFirst.complete(Unit)
    withTimeout(2_000) { secondStarted.await() }
    assertEquals(listOf("a", "b"), listOf(finishes.receive(), finishes.receive()))
  }

  @Test
  fun `different widgets execute concurrently`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val secondStarted = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val finishes = Channel<Unit>(Channel.UNLIMITED)
    val coordinator = coordinator<Unit>()

    coordinator.submit(
      appWidgetId = 1,
      mutationId = "widget-1",
      mutate = {
        firstStarted.complete(Unit)
        release.await()
      },
      deliver = {},
      finish = { finishes.trySend(Unit).getOrThrow() },
    )
    coordinator.submit(
      appWidgetId = 2,
      mutationId = "widget-2",
      mutate = {
        secondStarted.complete(Unit)
        release.await()
      },
      deliver = {},
      finish = { finishes.trySend(Unit).getOrThrow() },
    )

    withTimeout(2_000) {
      firstStarted.await()
      secondStarted.await()
    }
    release.complete(Unit)
    withTimeout(2_000) {
      finishes.receive()
      finishes.receive()
    }
  }

  @Test
  fun `newer generation suppresses stale render and delivery`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val staleCurrentChecks = Channel<Boolean>(Channel.UNLIMITED)
    val deliveries = Channel<String>(Channel.UNLIMITED)
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = coordinator<String>()

    coordinator.submit(
      appWidgetId = 4,
      mutationId = "old",
      mutate = { generation ->
        firstStarted.complete(Unit)
        withContext(NonCancellable) { releaseFirst.await() }
        staleCurrentChecks.trySend(generation.isCurrent()).getOrThrow()
        "old"
      },
      deliver = { deliveries.trySend(it).getOrThrow() },
      finish = { finishes.trySend("old").getOrThrow() },
    )
    firstStarted.await()
    coordinator.submit(
      appWidgetId = 4,
      mutationId = "new",
      mutate = { generation ->
        assertTrue(generation.isCurrent())
        "new"
      },
      deliver = { deliveries.trySend(it).getOrThrow() },
      finish = { finishes.trySend("new").getOrThrow() },
    )

    releaseFirst.complete(Unit)

    assertFalse(withTimeout(2_000) { staleCurrentChecks.receive() })
    assertEquals("new", withTimeout(2_000) { deliveries.receive() })
    assertEquals(listOf("old", "new"), listOf(finishes.receive(), finishes.receive()))
    yield()
    assertTrue(deliveries.tryReceive().isFailure)
  }

  @Test
  fun `stale generation still runs post persistence effects`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val postPersistenceEffects = Channel<String>(Channel.UNLIMITED)
    val deliveries = Channel<String>(Channel.UNLIMITED)
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = coordinator<String>()

    coordinator.submit(
      appWidgetId = 5,
      mutationId = "old",
      mutate = {
        firstStarted.complete(Unit)
        releaseFirst.await()
        "old"
      },
      afterPersist = { postPersistenceEffects.trySend(it).getOrThrow() },
      deliver = { deliveries.trySend(it).getOrThrow() },
      finish = { finishes.trySend("old").getOrThrow() },
    )
    firstStarted.await()
    coordinator.submit(
      appWidgetId = 5,
      mutationId = "new",
      mutate = { "new" },
      afterPersist = { postPersistenceEffects.trySend(it).getOrThrow() },
      deliver = { deliveries.trySend(it).getOrThrow() },
      finish = { finishes.trySend("new").getOrThrow() },
    )

    releaseFirst.complete(Unit)

    assertEquals(
      listOf("old", "new"),
      listOf(postPersistenceEffects.receive(), postPersistenceEffects.receive()),
    )
    assertEquals("new", deliveries.receive())
    assertEquals(listOf("old", "new"), listOf(finishes.receive(), finishes.receive()))
    yield()
    assertTrue(deliveries.tryReceive().isFailure)
  }

  @Test
  fun `binding invalidation suppresses stale effects across rebind clear and return to owner`() = runBlocking {
    val staleStarted = CompletableDeferred<Unit>()
    val releaseStale = CompletableDeferred<Unit>()
    val postPersistenceEffects = Channel<String>(Channel.UNLIMITED)
    val deliveries = Channel<String>(Channel.UNLIMITED)
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = coordinator<String>()

    coordinator.submit(
      appWidgetId = 12,
      mutationId = "owner-a-old",
      mutate = {
        staleStarted.complete(Unit)
        withContext(NonCancellable) { releaseStale.await() }
        "owner-a-old"
      },
      afterPersist = { postPersistenceEffects.trySend(it).getOrThrow() },
      deliver = { deliveries.trySend(it).getOrThrow() },
      finish = { finishes.trySend("owner-a-old").getOrThrow() },
    )
    staleStarted.await()

    coordinator.invalidateBinding() // A to B.
    coordinator.invalidateBinding() // Clear or B to A must not revive old A work.
    releaseStale.complete(Unit)

    assertEquals("owner-a-old", withTimeout(2_000) { finishes.receive() })
    assertTrue(postPersistenceEffects.tryReceive().isFailure)
    assertTrue(deliveries.tryReceive().isFailure)

    coordinator.submit(
      appWidgetId = 12,
      mutationId = "owner-a-current",
      mutate = { "owner-a-current" },
      afterPersist = { postPersistenceEffects.trySend(it).getOrThrow() },
      deliver = { deliveries.trySend(it).getOrThrow() },
      finish = { finishes.trySend("owner-a-current").getOrThrow() },
    )

    assertEquals("owner-a-current", withTimeout(2_000) { postPersistenceEffects.receive() })
    assertEquals("owner-a-current", withTimeout(2_000) { deliveries.receive() })
    assertEquals("owner-a-current", withTimeout(2_000) { finishes.receive() })
  }

  @Test
  fun `current commit is linearized with same widget submission`() = runBlocking {
    val commitEntered = CompletableDeferred<Unit>()
    val releaseCommit = CountDownLatch(1)
    val submitAttempted = CompletableDeferred<Unit>()
    val submitReturned = CompletableDeferred<Unit>()
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = NanoflowWidgetFocusMutationCoordinator<String>(
      scope = this,
      processingContext = Dispatchers.Default,
      deliveryContext = EmptyCoroutineContext,
    )

    coordinator.submit(
      appWidgetId = 6,
      mutationId = "old",
      mutate = { generation ->
        assertTrue(
          generation.commitIfCurrent {
            commitEntered.complete(Unit)
            assertTrue(releaseCommit.await(2, TimeUnit.SECONDS))
          },
        )
        "old"
      },
      deliver = {},
      finish = { finishes.trySend("old").getOrThrow() },
    )
    commitEntered.await()

    val submitJob = launch(Dispatchers.Default) {
      submitAttempted.complete(Unit)
      coordinator.submit(
        appWidgetId = 6,
        mutationId = "new",
        mutate = { "new" },
        deliver = {},
        finish = { finishes.trySend("new").getOrThrow() },
      )
      submitReturned.complete(Unit)
    }
    submitAttempted.await()

    assertEquals(null, withTimeoutOrNull(100) { submitReturned.await() })
    releaseCommit.countDown()
    withTimeout(2_000) { submitReturned.await() }
    submitJob.join()
    assertEquals(listOf("old", "new"), listOf(finishes.receive(), finishes.receive()))
  }

  @Test
  fun `different widget commit proceeds while another widget commit is blocked`() = runBlocking {
    val firstCommitEntered = CompletableDeferred<Unit>()
    val releaseFirstCommit = CountDownLatch(1)
    val secondCommitted = CompletableDeferred<Unit>()
    val finishes = Channel<String>(Channel.UNLIMITED)
    val coordinator = NanoflowWidgetFocusMutationCoordinator<String>(
      scope = this,
      processingContext = Dispatchers.Default,
      deliveryContext = EmptyCoroutineContext,
    )

    coordinator.submit(
      appWidgetId = 10,
      mutationId = "widget-a",
      mutate = { generation ->
        assertTrue(
          generation.commitIfCurrent {
            firstCommitEntered.complete(Unit)
            assertTrue(releaseFirstCommit.await(2, TimeUnit.SECONDS))
          },
        )
        "a"
      },
      deliver = {},
      finish = { finishes.trySend("a").getOrThrow() },
    )
    firstCommitEntered.await()

    val secondSubmitJob = launch(Dispatchers.Default) {
      coordinator.submit(
        appWidgetId = 11,
        mutationId = "widget-b",
        mutate = { generation ->
          assertTrue(generation.commitIfCurrent { secondCommitted.complete(Unit) })
          "b"
        },
        deliver = {},
        finish = { finishes.trySend("b").getOrThrow() },
      )
    }
    val committedBeforeFirstRelease = try {
      withTimeoutOrNull(500) { secondCommitted.await() } != null
    } finally {
      releaseFirstCommit.countDown()
    }

    secondSubmitJob.join()
    val completed = setOf(finishes.receive(), finishes.receive())
    assertTrue(committedBeforeFirstRelease)
    assertEquals(setOf("a", "b"), completed)
  }

  @Test
  fun `failure finishes once and does not stop the widget queue`() = runBlocking {
    val failures = Channel<Throwable>(Channel.UNLIMITED)
    val delivered = CompletableDeferred<String>()
    val firstFinishCount = AtomicInteger()
    val secondFinishCount = AtomicInteger()
    val coordinator = coordinator<String>(reportFailure = { failures.trySend(it).getOrThrow() })

    coordinator.submit(
      appWidgetId = 9,
      mutationId = "fails",
      mutate = { error("persistence failed") },
      deliver = { throw AssertionError("failed mutation must not deliver") },
      finish = { firstFinishCount.incrementAndGet() },
    )
    coordinator.submit(
      appWidgetId = 9,
      mutationId = "recovers",
      mutate = { "recovered" },
      deliver = { delivered.complete(it) },
      finish = { secondFinishCount.incrementAndGet() },
    )

    assertEquals("persistence failed", withTimeout(2_000) { failures.receive() }.message)
    assertEquals("recovered", withTimeout(2_000) { delivered.await() })
    yield()
    assertEquals(1, firstFinishCount.get())
    assertEquals(1, secondFinishCount.get())
  }

  @Test
  fun `latest duplicate coalesces persistence and finishes every receiver`() = runBlocking {
    val started = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val delivered = CompletableDeferred<String>()
    val mutationCount = AtomicInteger()
    val firstFinishCount = AtomicInteger()
    val duplicateFinishCount = AtomicInteger()
    val coordinator = coordinator<String>()

    coordinator.submit(
      appWidgetId = 3,
      mutationId = "same-request",
      mutate = {
        mutationCount.incrementAndGet()
        started.complete(Unit)
        release.await()
        "result"
      },
      deliver = { error("duplicate owner should replace the original delivery") },
      finish = { firstFinishCount.incrementAndGet() },
    )
    started.await()
    coordinator.submit(
      appWidgetId = 3,
      mutationId = "same-request",
      mutate = { error("duplicate mutation must not execute twice") },
      deliver = { delivered.complete(it) },
      finish = { duplicateFinishCount.incrementAndGet() },
    )

    release.complete(Unit)

    assertEquals("result", withTimeout(2_000) { delivered.await() })
    yield()
    assertEquals(1, mutationCount.get())
    assertEquals(1, firstFinishCount.get())
    assertEquals(1, duplicateFinishCount.get())
  }

  private fun <Result> CoroutineScope.coordinator(
    reportFailure: (Throwable) -> Unit = {},
  ): NanoflowWidgetFocusMutationCoordinator<Result> {
    return NanoflowWidgetFocusMutationCoordinator(
      scope = this,
      processingContext = EmptyCoroutineContext,
      deliveryContext = EmptyCoroutineContext,
      reportFailure = reportFailure,
    )
  }
}
