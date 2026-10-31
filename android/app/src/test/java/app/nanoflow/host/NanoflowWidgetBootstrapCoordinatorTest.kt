package app.nanoflow.host

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class NanoflowWidgetBootstrapCoordinatorTest {
  @Test
  fun `submit returns before persistence completes`() = runBlocking {
    val consumeStarted = CompletableDeferred<Unit>()
    val releaseConsume = CompletableDeferred<Unit>()
    val outcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val coordinator = coordinator<String> { request ->
      assertEquals("callback-a", request)
      consumeStarted.complete(Unit)
      releaseConsume.await()
      true
    }
    val owner = coordinator.attach { outcomes.trySend(it).getOrThrow() }

    val generation = coordinator.submit(owner, "callback-a")

    assertEquals(1L, generation)
    consumeStarted.await()
    assertTrue(outcomes.tryReceive().isFailure)
    releaseConsume.complete(Unit)
    val outcome = assertIs<NanoflowWidgetBootstrapOutcome.Completed>(outcomes.receive())
    assertTrue(outcome.accepted)
    assertEquals(1L, outcome.generation)
    assertEquals(fingerprint("callback-a"), outcome.fingerprint)
  }

  @Test
  fun `FIFO persistence continues while a newer callback suppresses stale UI`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val secondStarted = CompletableDeferred<Unit>()
    val releaseSecond = CompletableDeferred<Unit>()
    val sequence = mutableListOf<String>()
    val outcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val coordinator = coordinator<String> { request ->
      sequence += "$request:start"
      when (request) {
        "callback-a" -> withContext(NonCancellable) {
          firstStarted.complete(Unit)
          releaseFirst.await()
        }
        "callback-b" -> {
          secondStarted.complete(Unit)
          releaseSecond.await()
        }
      }
      sequence += "$request:finish"
      true
    }
    val owner = coordinator.attach { outcomes.trySend(it).getOrThrow() }

    coordinator.submit(owner, "callback-a")
    firstStarted.await()
    coordinator.submit(owner, "callback-b")

    assertFalse(secondStarted.isCompleted, "B must not overlap A persistence")
    releaseFirst.complete(Unit)
    secondStarted.await()
    assertTrue(outcomes.tryReceive().isFailure, "A completion must not reach UI after B arrives")
    releaseSecond.complete(Unit)

    val outcome = assertIs<NanoflowWidgetBootstrapOutcome.Completed>(outcomes.receive())
    assertEquals(fingerprint("callback-b"), outcome.fingerprint)
    assertEquals(
      listOf("callback-a:start", "callback-a:finish", "callback-b:start", "callback-b:finish"),
      sequence,
    )
  }

  @Test
  fun `in flight and completed duplicates consume once and deliver to the latest owner`() = runBlocking {
    val consumeStarted = CompletableDeferred<Unit>()
    val releaseConsume = CompletableDeferred<Unit>()
    var consumeCalls = 0
    val ownerOneOutcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val ownerTwoOutcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val ownerThreeOutcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val coordinator = coordinator<String> {
      consumeCalls += 1
      consumeStarted.complete(Unit)
      releaseConsume.await()
      true
    }
    val ownerOne = coordinator.attach { ownerOneOutcomes.trySend(it).getOrThrow() }
    coordinator.submit(ownerOne, "same-callback")
    consumeStarted.await()

    val ownerTwo = coordinator.attach { ownerTwoOutcomes.trySend(it).getOrThrow() }
    val recreationGeneration = coordinator.submit(ownerTwo, "same-callback")
    coordinator.detach(ownerOne)
    releaseConsume.complete(Unit)

    val recreationOutcome = assertIs<NanoflowWidgetBootstrapOutcome.Completed>(ownerTwoOutcomes.receive())
    assertEquals(recreationGeneration, recreationOutcome.generation)
    assertTrue(ownerOneOutcomes.tryReceive().isFailure)
    assertEquals(1, consumeCalls)

    coordinator.detach(ownerTwo)
    val ownerThree = coordinator.attach { ownerThreeOutcomes.trySend(it).getOrThrow() }
    val cachedGeneration = coordinator.submit(ownerThree, "same-callback")
    val cachedOutcome = assertIs<NanoflowWidgetBootstrapOutcome.Completed>(ownerThreeOutcomes.receive())

    assertEquals(cachedGeneration, cachedOutcome.generation)
    assertEquals(1, consumeCalls, "completed recreation duplicate must use bounded in-process dedupe")
  }

  @Test
  fun `destroyed owner receives no late persistence result`() = runBlocking {
    val consumeStarted = CompletableDeferred<Unit>()
    val releaseConsume = CompletableDeferred<Unit>()
    val consumeFinished = CompletableDeferred<Unit>()
    val outcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val coordinator = coordinator<String> {
      consumeStarted.complete(Unit)
      withContext(NonCancellable) { releaseConsume.await() }
      consumeFinished.complete(Unit)
      true
    }
    val owner = coordinator.attach { outcomes.trySend(it).getOrThrow() }
    coordinator.submit(owner, "callback-a")
    consumeStarted.await()

    coordinator.detach(owner)
    releaseConsume.complete(Unit)
    consumeFinished.await()
    yield()

    assertTrue(outcomes.tryReceive().isFailure)
  }

  @Test
  fun `errors expose only generation fingerprint and exception type`() = runBlocking {
    val outcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val coordinator = coordinator<BootstrapTestRequest>(
      fingerprint = { it.fingerprint },
      consume = { throw SensitiveBootstrapFailure("widget-token=secret") },
    )
    val owner = coordinator.attach { outcomes.trySend(it).getOrThrow() }

    val generation = coordinator.submit(owner, BootstrapTestRequest("sha256-redacted", "raw-secret"))
    val outcome = assertIs<NanoflowWidgetBootstrapOutcome.Failed>(outcomes.receive())

    assertEquals(generation, outcome.generation)
    assertEquals("sha256-redacted", outcome.fingerprint)
    assertEquals("SensitiveBootstrapFailure", outcome.exceptionType)
    assertFalse(outcome.toString().contains("raw-secret"))
    assertFalse(outcome.toString().contains("widget-token"))
  }

  @Test
  fun `stale errors remain diagnostic without reaching stale UI`() = runBlocking {
    val firstStarted = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val outcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val diagnostics = Channel<NanoflowWidgetBootstrapOutcome.Failed>(Channel.UNLIMITED)
    val coordinator = coordinator<String>(reportFailure = { diagnostics.trySend(it).getOrThrow() }) { request ->
      if (request == "callback-a") {
        firstStarted.complete(Unit)
        withContext(NonCancellable) { releaseFirst.await() }
        throw SensitiveBootstrapFailure("widget-token=secret")
      }
      true
    }
    val owner = coordinator.attach { outcomes.trySend(it).getOrThrow() }
    coordinator.submit(owner, "callback-a")
    firstStarted.await()
    coordinator.submit(owner, "callback-b")

    releaseFirst.complete(Unit)

    val diagnostic = diagnostics.receive()
    val currentOutcome = assertIs<NanoflowWidgetBootstrapOutcome.Completed>(outcomes.receive())
    assertEquals(1L, diagnostic.generation)
    assertEquals(fingerprint("callback-a"), diagnostic.fingerprint)
    assertEquals("SensitiveBootstrapFailure", diagnostic.exceptionType)
    assertEquals(fingerprint("callback-b"), currentOutcome.fingerprint)
    assertFalse(currentOutcome.toString().contains("callback-a"))
  }

  @Test
  fun `fingerprint covers exact callback identity without exposing it`() {
    val fields = BootstrapIdentityFields()
    val baseline = fields.fingerprint()
    val variants = listOf(
      fields.copy(bootstrapNonce = "nonce-b"),
      fields.copy(hostInstanceId = "host-b"),
      fields.copy(instanceId = "instance-b"),
      fields.copy(deviceId = "device-b"),
      fields.copy(installationId = "install-b"),
      fields.copy(bindingGeneration = 8),
      fields.copy(expiresAt = "2031-01-01T00:00:00Z"),
    )

    assertEquals(baseline, fields.fingerprint())
    assertEquals(64, baseline.length)
    assertTrue(baseline.all { it in '0'..'9' || it in 'a'..'f' })
    assertTrue(variants.all { it.fingerprint() != baseline })
    listOf(
      fields.bootstrapNonce,
      fields.hostInstanceId,
      fields.instanceId,
      fields.deviceId,
      fields.installationId,
      fields.expiresAt,
    ).forEach { rawValue -> assertFalse(baseline.contains(rawValue)) }
  }

  @Test
  fun `a distinct callback evicts completed dedupe state`() = runBlocking {
    val consumeCounts = mutableMapOf<String, Int>()
    val outcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val coordinator = coordinator<String> { request ->
      consumeCounts[request] = (consumeCounts[request] ?: 0) + 1
      true
    }
    val owner = coordinator.attach { outcomes.trySend(it).getOrThrow() }

    coordinator.submit(owner, "callback-a")
    outcomes.receive()
    coordinator.submit(owner, "callback-b")
    outcomes.receive()
    coordinator.submit(owner, "callback-a")
    outcomes.receive()

    assertEquals(mapOf("callback-a" to 2, "callback-b" to 1), consumeCounts)
  }

  @Test
  fun `pending queue capacity fails closed with redacted output`() = runBlocking {
    val releaseFirst = CompletableDeferred<Unit>()
    val firstStarted = CompletableDeferred<Unit>()
    val releaseSecond = CompletableDeferred<Unit>()
    val secondFinished = CompletableDeferred<Unit>()
    val outcomes = Channel<NanoflowWidgetBootstrapOutcome>(Channel.UNLIMITED)
    val coordinator = coordinator<String>(maxPendingRequests = 1) { request ->
      when (request) {
        "callback-a" -> {
          firstStarted.complete(Unit)
          releaseFirst.await()
        }
        "callback-b" -> {
          releaseSecond.await()
          secondFinished.complete(Unit)
        }
      }
      true
    }
    val owner = coordinator.attach { outcomes.trySend(it).getOrThrow() }
    coordinator.submit(owner, "callback-a")
    firstStarted.await()
    coordinator.submit(owner, "callback-b")

    val overflowGeneration = coordinator.submit(owner, "callback-c")
    val overflow = assertIs<NanoflowWidgetBootstrapOutcome.Failed>(outcomes.receive())

    assertEquals(overflowGeneration, overflow.generation)
    assertEquals(fingerprint("callback-c"), overflow.fingerprint)
    assertEquals("BootstrapQueueCapacityExceeded", overflow.exceptionType)

    releaseFirst.complete(Unit)
    releaseSecond.complete(Unit)
    secondFinished.await()
  }

  private fun <Request> kotlinx.coroutines.CoroutineScope.coordinator(
    maxPendingRequests: Int = 32,
    fingerprint: (Request) -> String = { fingerprint(it.toString()) },
    reportFailure: (NanoflowWidgetBootstrapOutcome.Failed) -> Unit = {},
    consume: suspend (Request) -> Boolean,
  ): NanoflowWidgetBootstrapCoordinator<Request> {
    return NanoflowWidgetBootstrapCoordinator(
      scope = this,
      processingContext = EmptyCoroutineContext,
      deliveryContext = EmptyCoroutineContext,
      maxPendingRequests = maxPendingRequests,
      fingerprint = fingerprint,
      reportFailure = reportFailure,
      consume = consume,
    )
  }

  private fun fingerprint(value: String): String = "fingerprint:$value"

  private data class BootstrapTestRequest(
    val fingerprint: String,
    val rawValue: String,
  )

  private data class BootstrapIdentityFields(
    val bootstrapNonce: String = "nonce-a",
    val hostInstanceId: String = "host-a",
    val instanceId: String = "instance-a",
    val deviceId: String = "device-a",
    val installationId: String = "install-a",
    val bindingGeneration: Int = 7,
    val expiresAt: String = "2030-01-01T00:00:00Z",
  ) {
    fun fingerprint(): String {
      return buildNanoflowWidgetBootstrapFingerprint(
        bootstrapNonce = bootstrapNonce,
        hostInstanceId = hostInstanceId,
        instanceId = instanceId,
        deviceId = deviceId,
        installationId = installationId,
        bindingGeneration = bindingGeneration,
        expiresAt = expiresAt,
        fallbackIdentity = null,
      )
    }
  }

  private class SensitiveBootstrapFailure(message: String) : RuntimeException(message)
}
