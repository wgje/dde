package app.nanoflow.host

import android.content.Context
import android.net.Uri
import java.security.MessageDigest
import java.util.ArrayDeque
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

internal class NanoflowWidgetBootstrapOwner internal constructor(
  internal val id: Long,
)

internal sealed interface NanoflowWidgetBootstrapOutcome {
  val generation: Long
  val fingerprint: String

  data class Completed(
    override val generation: Long,
    override val fingerprint: String,
    val accepted: Boolean,
  ) : NanoflowWidgetBootstrapOutcome

  data class Failed(
    override val generation: Long,
    override val fingerprint: String,
    val exceptionType: String,
  ) : NanoflowWidgetBootstrapOutcome
}

/** Serializes process-local bootstrap persistence while Activity owners remain replaceable. */
internal class NanoflowWidgetBootstrapCoordinator<Request>(
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
  private val processingContext: CoroutineContext = Dispatchers.IO,
  private val deliveryContext: CoroutineContext = Dispatchers.Main.immediate,
  private val maxPendingRequests: Int = DEFAULT_MAX_PENDING_REQUESTS,
  private val fingerprint: (Request) -> String,
  private val reportFailure: (NanoflowWidgetBootstrapOutcome.Failed) -> Unit = {},
  private val consume: suspend (Request) -> Boolean,
) {
  private val lock = Any()
  private val pending = ArrayDeque<PendingRequest<Request>>()

  private var active: PendingRequest<Request>? = null
  private var attachedOwner: AttachedOwner? = null
  private var lastCompleted: CompletedRequest? = null
  private var workerRunning = false
  private var nextOwnerId = 0L
  private var nextGeneration = 0L
  private var latestGeneration = 0L

  init {
    require(maxPendingRequests > 0) { "maxPendingRequests must be positive" }
  }

  fun attach(deliver: (NanoflowWidgetBootstrapOutcome) -> Unit): NanoflowWidgetBootstrapOwner {
    return synchronized(lock) {
      val owner = NanoflowWidgetBootstrapOwner(++nextOwnerId)
      attachedOwner = AttachedOwner(owner = owner, deliver = deliver)
      owner
    }
  }

  fun detach(owner: NanoflowWidgetBootstrapOwner) {
    synchronized(lock) {
      if (attachedOwner?.owner == owner) {
        attachedOwner = null
      }
    }
  }

  fun submit(owner: NanoflowWidgetBootstrapOwner, request: Request): Long? {
    var generation = 0L
    var requestFingerprint = ""
    var immediateResult: ConsumptionResult? = null
    var shouldReportImmediateFailure = false
    var shouldStartWorker = false

    synchronized(lock) {
      if (attachedOwner?.owner != owner) {
        return null
      }

      generation = ++nextGeneration
      latestGeneration = generation
      requestFingerprint = fingerprint(request)

      val duplicate = active?.takeIf { it.fingerprint == requestFingerprint }
        ?: pending.firstOrNull { it.fingerprint == requestFingerprint }
      if (duplicate != null) {
        duplicate.ownerId = owner.id
        duplicate.generation = generation
        return generation
      }

      val completed = lastCompleted?.takeIf { it.fingerprint == requestFingerprint }
      if (completed != null) {
        immediateResult = completed.result
      } else {
        lastCompleted = null
        if (pending.size >= maxPendingRequests) {
          immediateResult = ConsumptionResult.Failed(QUEUE_CAPACITY_ERROR_TYPE)
          shouldReportImmediateFailure = true
        } else {
          pending.addLast(
            PendingRequest(
              request = request,
              fingerprint = requestFingerprint,
              ownerId = owner.id,
              generation = generation,
            ),
          )
          if (!workerRunning) {
            workerRunning = true
            shouldStartWorker = true
          }
        }
      }
    }

    immediateResult?.let { result ->
      val failure = result.toFailure(generation, requestFingerprint)
      if (shouldReportImmediateFailure && failure != null) {
        reportFailure(failure)
      }
      scheduleDelivery(owner.id, generation, requestFingerprint, result)
    }
    if (shouldStartWorker) {
      scope.launch { drainQueue() }
    }
    return generation
  }

  private suspend fun drainQueue() {
    while (true) {
      val current = synchronized(lock) {
        val next = pending.pollFirst()
        if (next == null) {
          active = null
          workerRunning = false
          return
        }
        active = next
        next
      }

      val result = try {
        ConsumptionResult.Completed(withContext(processingContext) { consume(current.request) })
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        ConsumptionResult.Failed(error::class.simpleName ?: UNKNOWN_ERROR_TYPE)
      }

      val delivery = synchronized(lock) {
        active = null
        val generation = current.generation
        val ownerId = current.ownerId
        if (generation == latestGeneration) {
          lastCompleted = CompletedRequest(current.fingerprint, result)
        }
        Delivery(
          ownerId = ownerId,
          generation = generation,
          fingerprint = current.fingerprint,
          result = result,
        )
      }

      result.toFailure(delivery.generation, delivery.fingerprint)?.let(reportFailure)
      deliverIfCurrent(delivery)
    }
  }

  private fun scheduleDelivery(
    ownerId: Long,
    generation: Long,
    requestFingerprint: String,
    result: ConsumptionResult,
  ) {
    scope.launch {
      deliverIfCurrent(
        Delivery(
          ownerId = ownerId,
          generation = generation,
          fingerprint = requestFingerprint,
          result = result,
        ),
      )
    }
  }

  private suspend fun deliverIfCurrent(delivery: Delivery) {
    withContext(deliveryContext) {
      val target = synchronized(lock) {
        val owner = attachedOwner
        if (delivery.generation != latestGeneration || owner?.owner?.id != delivery.ownerId) {
          null
        } else {
          owner.deliver to delivery.result.toOutcome(delivery.generation, delivery.fingerprint)
        }
      }
      target?.let { (deliver, outcome) -> deliver(outcome) }
    }
  }

  private data class AttachedOwner(
    val owner: NanoflowWidgetBootstrapOwner,
    val deliver: (NanoflowWidgetBootstrapOutcome) -> Unit,
  )

  private data class PendingRequest<Request>(
    val request: Request,
    val fingerprint: String,
    var ownerId: Long,
    var generation: Long,
  )

  private data class CompletedRequest(
    val fingerprint: String,
    val result: ConsumptionResult,
  )

  private data class Delivery(
    val ownerId: Long,
    val generation: Long,
    val fingerprint: String,
    val result: ConsumptionResult,
  )

  private sealed interface ConsumptionResult {
    data class Completed(val accepted: Boolean) : ConsumptionResult
    data class Failed(val exceptionType: String) : ConsumptionResult

    fun toOutcome(generation: Long, fingerprint: String): NanoflowWidgetBootstrapOutcome {
      return when (this) {
        is Completed -> NanoflowWidgetBootstrapOutcome.Completed(
          generation = generation,
          fingerprint = fingerprint,
          accepted = accepted,
        )
        is Failed -> NanoflowWidgetBootstrapOutcome.Failed(
          generation = generation,
          fingerprint = fingerprint,
          exceptionType = exceptionType,
        )
      }
    }

    fun toFailure(
      generation: Long,
      fingerprint: String,
    ): NanoflowWidgetBootstrapOutcome.Failed? {
      return (this as? Failed)?.let { failure ->
        NanoflowWidgetBootstrapOutcome.Failed(
          generation = generation,
          fingerprint = fingerprint,
          exceptionType = failure.exceptionType,
        )
      }
    }
  }

  private companion object {
    const val DEFAULT_MAX_PENDING_REQUESTS = 32
    const val QUEUE_CAPACITY_ERROR_TYPE = "BootstrapQueueCapacityExceeded"
    const val UNKNOWN_ERROR_TYPE = "UnknownBootstrapFailure"
  }
}

internal object NanoflowWidgetBootstrapProcessCoordinator {
  private val lock = Any()

  @Volatile
  private var coordinator: NanoflowWidgetBootstrapCoordinator<Uri?>? = null

  fun attach(
    context: Context,
    deliver: (NanoflowWidgetBootstrapOutcome) -> Unit,
  ): NanoflowWidgetBootstrapOwner {
    return coordinator(context).attach(deliver)
  }

  fun submit(owner: NanoflowWidgetBootstrapOwner, callbackUri: Uri?): Long? {
    return coordinator?.submit(owner, callbackUri)
  }

  fun detach(owner: NanoflowWidgetBootstrapOwner) {
    coordinator?.detach(owner)
  }

  private fun coordinator(context: Context): NanoflowWidgetBootstrapCoordinator<Uri?> {
    return coordinator ?: synchronized(lock) {
      coordinator ?: createCoordinator(context.applicationContext).also { coordinator = it }
    }
  }

  private fun createCoordinator(context: Context): NanoflowWidgetBootstrapCoordinator<Uri?> {
    val repository = NanoflowWidgetRepository(context)
    return NanoflowWidgetBootstrapCoordinator(
      fingerprint = ::bootstrapRequestFingerprint,
      reportFailure = { failure ->
        NanoflowWidgetTelemetry.warn(
          event = "widget_bootstrap_callback_consume_failed",
          fields = mapOf(
            "generation" to failure.generation,
            "requestFingerprint" to failure.fingerprint,
            "errorType" to failure.exceptionType,
          ),
        )
      },
      consume = repository::consumeBootstrapUri,
    )
  }

  private fun bootstrapRequestFingerprint(uri: Uri?): String {
    val payload = NanoflowBootstrapContract.parseBootstrapPayload(uri)
    return if (payload == null) {
      buildNanoflowWidgetBootstrapFingerprint(
        bootstrapNonce = null,
        hostInstanceId = null,
        instanceId = null,
        deviceId = null,
        installationId = null,
        bindingGeneration = null,
        expiresAt = null,
        fallbackIdentity = uri?.toString() ?: NULL_CALLBACK_IDENTITY,
      )
    } else {
      buildNanoflowWidgetBootstrapFingerprint(
        bootstrapNonce = payload.bootstrapNonce,
        hostInstanceId = payload.hostInstanceId,
        instanceId = payload.instanceId,
        deviceId = payload.deviceId,
        installationId = payload.installationId,
        bindingGeneration = payload.bindingGeneration,
        expiresAt = payload.expiresAt,
        fallbackIdentity = null,
      )
    }
  }

  private const val NULL_CALLBACK_IDENTITY = "null-bootstrap-callback"
}

internal fun buildNanoflowWidgetBootstrapFingerprint(
  bootstrapNonce: String?,
  hostInstanceId: String?,
  instanceId: String?,
  deviceId: String?,
  installationId: String?,
  bindingGeneration: Int?,
  expiresAt: String?,
  fallbackIdentity: String?,
): String {
  val canonicalIdentity = listOf(
    "bootstrapNonce=${bootstrapNonce.orEmpty()}",
    "hostInstanceId=${hostInstanceId.orEmpty()}",
    "instanceId=${instanceId.orEmpty()}",
    "deviceId=${deviceId.orEmpty()}",
    "installationId=${installationId.orEmpty()}",
    "bindingGeneration=${bindingGeneration?.toString().orEmpty()}",
    "expiresAt=${expiresAt.orEmpty()}",
    "fallbackIdentity=${fallbackIdentity.orEmpty()}",
  ).joinToString(separator = "\u0000")
  return MessageDigest.getInstance("SHA-256")
    .digest(canonicalIdentity.toByteArray(Charsets.UTF_8))
    .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
