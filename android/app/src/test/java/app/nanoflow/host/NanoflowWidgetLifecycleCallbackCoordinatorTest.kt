package app.nanoflow.host

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NanoflowWidgetLifecycleCallbackCoordinatorTest {
  @Test
  fun `mixed lifecycle callbacks run FIFO while later submission returns promptly`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val secondStarted = CompletableDeferred<Unit>()
    val order = Channel<String>(Channel.UNLIMITED)
    val coordinator = coordinator()

    coordinator.submit(
      work = {
        attempt {
          firstStarted.complete(Unit)
          releaseFirst.await()
          order.trySend("update").getOrThrow()
        }
      },
      finish = { order.trySend("finish-update").getOrThrow() },
    )
    firstStarted.await()

    coordinator.submit(
      work = {
        attempt {
          secondStarted.complete(Unit)
          order.trySend("resize").getOrThrow()
        }
      },
      finish = { order.trySend("finish-resize").getOrThrow() },
    )
    coordinator.submit(
      work = { attempt { order.trySend("delete").getOrThrow() } },
      finish = { order.trySend("finish-delete").getOrThrow() },
    )
    yield()

    assertFalse(secondStarted.isCompleted)
    releaseFirst.complete(Unit)
    withTimeout(2_000) { secondStarted.await() }

    assertEquals(
      listOf("update", "finish-update", "resize", "finish-resize", "delete", "finish-delete"),
      List(6) { order.receive() },
    )
  }

  @Test
  fun `attempt reporter and finish failures do not stop later callbacks`() = runBlocking {
    val reports = AtomicInteger()
    val firstFinish = AtomicInteger()
    val secondFinish = AtomicInteger()
    val stages = Channel<String>(Channel.UNLIMITED)
    val secondFinished = CompletableDeferred<Unit>()
    val coordinator = coordinator(reportFailure = {
      reports.incrementAndGet()
      error("reporter failed")
    })

    coordinator.submit(
      work = {
        attempt { error("widget persistence failed") }
        attempt { stages.trySend("telemetry-after-persistence-failure").getOrThrow() }
        attempt { error("telemetry failed") }
        attempt { stages.trySend("render-after-telemetry-failure").getOrThrow() }
      },
      finish = {
        firstFinish.incrementAndGet()
        error("finish failed")
      },
    )
    coordinator.submit(
      work = { attempt { stages.trySend("later-callback").getOrThrow() } },
      finish = {
        secondFinish.incrementAndGet()
        secondFinished.complete(Unit)
      },
    )

    withTimeout(2_000) { secondFinished.await() }
    assertEquals(
      listOf(
        "telemetry-after-persistence-failure",
        "render-after-telemetry-failure",
        "later-callback",
      ),
      List(3) { stages.receive() },
    )
    assertTrue(reports.get() >= 3)
    assertEquals(1, firstFinish.get())
    assertEquals(1, secondFinish.get())
  }

  @Test
  fun `submission failure is contained and finishes exactly once`() {
    val reports = AtomicInteger()
    val finishes = AtomicInteger()
    val throwingScope = object : CoroutineScope {
      override val coroutineContext: CoroutineContext
        get() = error("scope unavailable")
    }
    val coordinator = NanoflowWidgetLifecycleCallbackCoordinator(
      scope = throwingScope,
      processingContext = EmptyCoroutineContext,
      reportFailure = {
        reports.incrementAndGet()
        error("reporter failed")
      },
    )

    val result = runCatching {
      coordinator.submit(
        work = { attempt { error("must not start") } },
        finish = {
          finishes.incrementAndGet()
          error("finish failed")
        },
      )
    }

    assertTrue(result.isSuccess)
    assertTrue(reports.get() >= 2)
    assertEquals(1, finishes.get())
  }

  private fun CoroutineScope.coordinator(
    reportFailure: (Throwable) -> Unit = {},
  ): NanoflowWidgetLifecycleCallbackCoordinator {
    return NanoflowWidgetLifecycleCallbackCoordinator(
      scope = this,
      processingContext = EmptyCoroutineContext,
      reportFailure = reportFailure,
    )
  }
}
