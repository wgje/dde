package app.nanoflow.host

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertSame
import kotlin.test.assertTrue

class NanoflowTwaLaunchCoordinatorTest {
  @Test
  fun `incomplete preparation returns without committing`() = runBlocking {
    val prepared = CompletableDeferred<String>()
    val committed = CompletableDeferred<String>()
    val coordinator = coordinator<String>()

    val job = coordinator.start(
      prepare = { prepared.await() },
      onCommit = { committed.complete(it) },
      onError = { throw AssertionError("unexpected preparation error", it) },
    )

    assertTrue(job.isActive)
    assertTrue(!committed.isCompleted)

    prepared.complete("widget-uri")
    assertEquals("widget-uri", committed.await())
    job.join()
  }

  @Test
  fun `new generation rejects stale non cancellable completion`() = runBlocking {
    val oldRelease = CompletableDeferred<Unit>()
    val commits = mutableListOf<String>()
    val currentCommitted = CompletableDeferred<Unit>()
    val coordinator = coordinator<String>()

    val oldJob = coordinator.start(
      prepare = {
        withContext(NonCancellable) {
          oldRelease.await()
          "old-uri"
        }
      },
      onCommit = { commits += it },
      onError = { throw AssertionError("stale errors must not surface", it) },
    )
    val currentJob = coordinator.start(
      prepare = { "current-uri" },
      onCommit = {
        commits += it
        currentCommitted.complete(Unit)
      },
      onError = { throw AssertionError("unexpected preparation error", it) },
    )

    currentCommitted.await()
    oldRelease.complete(Unit)
    joinAll(oldJob, currentJob)

    assertEquals(listOf("current-uri"), commits)
  }

  @Test
  fun `one generation commits exactly once`() = runBlocking {
    val commits = mutableListOf<String>()
    val committed = CompletableDeferred<Unit>()
    val coordinator = coordinator<String>()

    val job = coordinator.start(
      prepare = { "only-uri" },
      onCommit = {
        commits += it
        committed.complete(Unit)
      },
      onError = { throw AssertionError("unexpected preparation error", it) },
    )

    committed.await()
    job.join()
    assertEquals(listOf("only-uri"), commits)
  }

  @Test
  fun `cancel prevents a non cancellable result from committing`() = runBlocking {
    val release = CompletableDeferred<Unit>()
    val commits = mutableListOf<String>()
    val coordinator = coordinator<String>()

    val job = coordinator.start(
      prepare = {
        withContext(NonCancellable) {
          release.await()
          "late-uri"
        }
      },
      onCommit = { commits += it },
      onError = { throw AssertionError("cancelled errors must not surface", it) },
    )

    coordinator.cancel()
    release.complete(Unit)
    job.join()

    assertTrue(commits.isEmpty())
  }

  @Test
  fun `preparation error never commits a fallback`() = runBlocking {
    val failure = IllegalStateException("datastore unavailable")
    val observedFailure = CompletableDeferred<Throwable>()
    val commits = mutableListOf<String>()
    val coordinator = coordinator<String>()

    val job = coordinator.start(
      prepare = { throw failure },
      onCommit = { commits += it },
      onError = { observedFailure.complete(it) },
    )

    val observed = assertIs<IllegalStateException>(observedFailure.await())
    assertEquals(failure.message, observed.message)
    job.join()
    assertTrue(commits.isEmpty())
  }

  @Test
  fun `winning value is delivered unchanged`() = runBlocking {
    val winningUri = Any()
    val committed = CompletableDeferred<Any>()
    val coordinator = coordinator<Any>()

    val job = coordinator.start(
      prepare = { winningUri },
      onCommit = { committed.complete(it) },
      onError = { throw AssertionError("unexpected preparation error", it) },
    )

    assertSame(winningUri, committed.await())
    job.join()
  }

  private fun <T> kotlinx.coroutines.CoroutineScope.coordinator(): NanoflowTwaLaunchCoordinator<T> {
    return NanoflowTwaLaunchCoordinator(
      scope = this,
      preparationContext = EmptyCoroutineContext,
    )
  }
}
